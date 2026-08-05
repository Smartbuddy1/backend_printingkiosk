// One-off helper to seed a few sample alert records so the Alert Center /
// Alert History UI can be previewed without waiting for a real printer error.
// Usage: node backend/seed-dummy-alerts.js [kioskId]
// Run it wherever DATABASE_URL is set (local .env for a dev DB, or on the
// EC2 box for prod). Safe to run more than once - ids are regenerated each
// time, so re-running just adds more sample rows. Delete this file whenever
// you're done with it.

const { loadEnv } = require("./load-env");
loadEnv();
const rdsStore = require("./rds-store");

async function seed() {
  const kioskId = process.argv[2] || "KIOSK-01";

  if (!rdsStore.enabled()) {
    console.error("DATABASE_URL is not set in this environment - nothing to seed against.");
    process.exit(1);
  }

  const snapshot = await rdsStore.loadSnapshot();
  const now = Date.now();
  const iso = (offsetMs) => new Date(now - offsetMs).toISOString();

  const dummyAlerts = [
    {
      id: "ALT-DUMMY-" + now + "-1",
      kioskId,
      category: "paper",
      title: `${kioskId} - Printer door open`,
      detail: "HP LaserJet Pro 4004: close the printer door or tray. Last updated: just now.",
      tone: "bad",
      status: "active",
      createdAt: iso(2 * 60 * 1000),
      resolvedAt: null
    },
    {
      id: "ALT-DUMMY-" + now + "-2",
      kioskId,
      category: "toner",
      title: `${kioskId} - Toner low`,
      detail: "HP LaserJet Pro 4004: keep a replacement toner ready. Last updated: 10 minutes ago.",
      tone: "warn",
      status: "resolved",
      createdAt: iso(60 * 60 * 1000),
      resolvedAt: iso(45 * 60 * 1000)
    },
    {
      id: "ALT-DUMMY-" + now + "-3",
      kioskId,
      category: "network",
      title: `${kioskId} - Kiosk Offline`,
      detail: "The kiosk PC has lost internet connection or is turned off.",
      tone: "bad",
      status: "resolved",
      createdAt: iso(3 * 60 * 60 * 1000),
      resolvedAt: iso(2.5 * 60 * 60 * 1000)
    }
  ];

  snapshot.alertLogs = [...(snapshot.alertLogs || []), ...dummyAlerts];
  await rdsStore.saveSnapshot(snapshot);

  console.log(`Seeded ${dummyAlerts.length} dummy alert(s) for ${kioskId}.`);
  process.exit(0);
}

seed().catch((error) => {
  console.error("Seed failed:", error.message);
  process.exit(1);
});
