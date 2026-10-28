"use strict";
const { Failure } = require("./security.cjs");
const { boundedBytes } = require("./provider.cjs");

// Read the authoritative kiosk setting from the existing, explicitly configured
// loopback backend. Never accept an enabled flag or an upstream URL from a browser.
async function requireKioskEnabled(config, kioskId, request = fetch) {
  if (typeof kioskId !== "string" || !/^[A-Z0-9_-]{1,32}$/.test(kioskId) || ["LOCAL-KIOSK", "UNASSIGNED-KIOSK"].includes(kioskId)) {
    throw new Failure("DIGILOCKER_KIOSK_DISABLED", 403);
  }
  let data;
  try {
    const response = await request(`${config.backend}/api/kiosk/config?kioskId=${encodeURIComponent(kioskId)}`, {
      redirect: "error", signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" }
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Configuration unavailable"); }
    const bytes = await boundedBytes(response, 2 * 1024 * 1024);
    try { data = JSON.parse(bytes.toString("utf8")); } finally { bytes.fill(0); }
  } catch { throw new Failure("DIGILOCKER_KIOSK_UNAVAILABLE", 503); }
  if (data?.kiosk?.kioskId !== kioskId || data.kiosk.customerSettings?.digilocker !== true) {
    throw new Failure("DIGILOCKER_KIOSK_DISABLED", 403);
  }
  return kioskId;
}
module.exports = { requireKioskEnabled };
