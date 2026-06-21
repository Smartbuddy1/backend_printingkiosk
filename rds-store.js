let Pool;

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const DATABASE_SSL = /^(true|1|require)$/i.test(process.env.DATABASE_SSL || process.env.PGSSLMODE || "");

let pool = null;

const collections = {
  jobs: { table: "kiosk_jobs", keyColumn: "job_id", keyField: "jobId" },
  payments: { table: "kiosk_payments", keyColumn: "payment_id", keyField: "paymentId" },
  services: { table: "kiosk_services", keyColumn: "service_id", keyField: "id" },
  kiosks: { table: "kiosks", keyColumn: "kiosk_id", keyField: "kioskId" },
  refunds: { table: "kiosk_refunds", keyColumn: "refund_id", keyField: "refundId" }
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

    CREATE TABLE IF NOT EXISTS kiosk_refunds (
      refund_id TEXT PRIMARY KEY,
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
    refunds: await loadCollection(client, "refunds"),
    kioskAdmins: await loadSetting(client, "kioskAdmins", []),
    projects: await loadSetting(client, "projects", []),
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
    await replaceCollection(client, "refunds", snapshot.refunds);
    await saveSetting(client, "kioskAdmins", snapshot.kioskAdmins || []);
    await saveSetting(client, "projects", snapshot.projects || []);
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
  close
};
