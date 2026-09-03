let Pool;

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const DATABASE_SSL = /^(true|1|require)$/i.test(process.env.DATABASE_SSL || process.env.PGSSLMODE || "");

let pool = null;

const collections = {
  jobs: { table: "kiosk_jobs", keyColumn: "job_id", keyField: "jobId" },
  payments: { table: "kiosk_payments", keyColumn: "payment_id", keyField: "paymentId" },
  services: { table: "kiosk_services", keyColumn: "service_id", keyField: "id" },
  kiosks: { table: "kiosks", keyColumn: "kiosk_id", keyField: "kioskId" },
  alertLogs: { table: "kiosk_alerts", keyColumn: "alert_id", keyField: "id" }
};

function enabled() {
  return Boolean(DATABASE_URL);
}

function getPool() {
  if (!enabled()) return null;

  if (!Pool) {
    ({ Pool } = require("pg"));
  }

  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined
    });
  }

  return pool;
}

async function initDatabase() {
  const client = getPool();
  if (!client) return false;

  await client.query(`
    CREATE TABLE IF NOT EXISTS kiosk_jobs (
      job_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kiosk_payments (
      payment_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kiosk_services (
      service_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kiosks (
      kiosk_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kiosk_alerts (
      alert_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  return true;
}

async function loadCollection(client, collection) {
  const meta = collections[collection];
  const result = await client.query(`SELECT data FROM ${meta.table} ORDER BY updated_at ASC`);
  return result.rows.map((row) => row.data);
}

async function loadSetting(client, key, fallback) {
  const result = await client.query("SELECT data FROM app_settings WHERE key = $1", [key]);
  return result.rows[0]?.data ?? fallback;
}

async function loadSnapshot() {
  const client = getPool();
  if (!client) return null;

  await initDatabase();

  return {
    jobs: await loadCollection(client, "jobs"),
    payments: await loadCollection(client, "payments"),
    services: await loadCollection(client, "services"),
    kiosks: await loadCollection(client, "kiosks"),
    alertLogs: await loadCollection(client, "alertLogs"),
    kioskAdmins: await loadSetting(client, "kioskAdmins", []),
    projects: await loadSetting(client, "projects", []),
    releases: await loadSetting(client, "releases", []),
    pricing: await loadSetting(client, "pricing", {}),
    config: await loadSetting(client, "config", {})
  };
}

async function replaceCollection(client, collection, records = []) {
  const meta = collections[collection];
  await client.query(`DELETE FROM ${meta.table}`);

  for (const record of records) {
    const id = String(record?.[meta.keyField] || "").trim();
    if (!id) continue;

    await client.query(
      `INSERT INTO ${meta.table} (${meta.keyColumn}, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (${meta.keyColumn})
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [id, JSON.stringify(record)]
    );
  }
}

async function upsertCollection(client, collection, records = []) {
  const meta = collections[collection];

  for (const record of records) {
    const id = String(record?.[meta.keyField] || "").trim();
    if (!id) continue;

    await client.query(
      `INSERT INTO ${meta.table} (${meta.keyColumn}, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (${meta.keyColumn})
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [id, JSON.stringify(record)]
    );
  }
}

async function saveSetting(client, key, data) {
  await client.query(
    `INSERT INTO app_settings (key, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [key, JSON.stringify(data || {})]
  );
}

async function saveSnapshot(snapshot) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await replaceCollection(client, "jobs", snapshot.jobs);
    await replaceCollection(client, "payments", snapshot.payments);
    await replaceCollection(client, "services", snapshot.services);
    await replaceCollection(client, "kiosks", snapshot.kiosks);
    // Alert history is append/update-only (rows are never removed, only marked
    // resolved) - upsert here instead of the destructive delete-then-reinsert
    // replaceCollection uses elsewhere. That way a save from a process with a
    // stale/partial in-memory alert list (e.g. a second server instance) can
    // never wipe out alert rows it simply doesn't know about yet.
    await upsertCollection(client, "alertLogs", snapshot.alertLogs);
    await saveSetting(client, "kioskAdmins", snapshot.kioskAdmins || []);
    await saveSetting(client, "projects", snapshot.projects || []);
    await saveSetting(client, "releases", snapshot.releases || []);
    await saveSetting(client, "pricing", snapshot.pricing);
    await saveSetting(client, "config", snapshot.config);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// A lightweight save for the kiosk heartbeat path (POST /api/kiosk/health,
// hit every 2s per online kiosk - see electron/printerHealthMonitor.js).
// That handler only ever touches the kiosk's own row and alert rows, so
// running it through the full saveSnapshot() above was rewriting the entire
// jobs/payments/services tables (delete-then-reinsert every row) on every
// single heartbeat, for no reason - with jobs/payments growing into the
// hundreds, that meant hundreds of unnecessary queries every 2 seconds,
// competing with everything else for a database connection and starving
// real request handling. Upsert-only, mirroring alertLogs above - a
// heartbeat only ever updates an existing kiosk row, never removes one, so
// there's nothing here that needs the destructive replace.
async function saveKioskHeartbeat(kiosks, alertLogs) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await upsertCollection(client, "kiosks", kiosks);
    await upsertCollection(client, "alertLogs", alertLogs);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  enabled,
  initDatabase,
  loadSnapshot,
  saveSnapshot,
  saveKioskHeartbeat,
  close
};
