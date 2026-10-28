"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { makeConfig } = require("../digilocker-local/config.cjs");

function hostedConfig(env = {}) {
  if (env.DIGILOCKER_MODE && env.DIGILOCKER_MODE !== "live") throw new Error("Hosted DigiLocker accepts live mode only");
  if (env.DIGILOCKER_LAN_DEMO === "true" || env.DIGILOCKER_LOCAL_PREVIEW === "true") throw new Error("Hosted DigiLocker cannot simulate documents, payment or printing");
  if (!env.PUBLIC_BASE_URL) throw new Error("Set PUBLIC_BASE_URL to the registered HTTPS backend origin");
  const publicBase = new URL(env.PUBLIC_BASE_URL);
  if(publicBase.protocol !== "https:")throw new Error("Hosted callback requires HTTPS");
  const allowedOrigins = [publicBase.origin];
  for (const entry of String(env.DIGILOCKER_ALLOWED_ORIGINS || "").split(",").filter(Boolean)) {
    const u = new URL(entry.trim());
    if(u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash)throw new Error("Allowed frontend origins must be exact HTTPS origins without paths");
    allowedOrigins.push(u.origin);
  }
  const enabled = env.DIGILOCKER_ENABLED === "true";
  if(enabled && allowedOrigins.length < 2)throw new Error("Set DIGILOCKER_ALLOWED_ORIGINS for the separate frontend");
  if(enabled && (!env.DIGILOCKER_CLIENT_ID || !env.DIGILOCKER_CLIENT_SECRET || !env.DIGILOCKER_REDIRECT_URI))throw new Error("Activation requires approved credentials and the registered redirect URI");
  const assets = __dirname;
  const config = makeConfig({...env,
    DIGILOCKER_ENABLED:String(enabled),DIGILOCKER_MODE:"live",DIGILOCKER_LOCAL_PREVIEW:"false",DIGILOCKER_LAN_DEMO:"false",
    DIGILOCKER_KIOSK_ID:"HOSTED-BROWSER-SESSIONS",DIGILOCKER_FRONTEND_DIR:assets,
    DIGILOCKER_PORT:env.DIGILOCKER_PORT || "5091"
  },{hosted:true});
  if(new URL(config.endpoints.authorize).hostname !== "digilocker.meripehchaan.gov.in")throw new Error("Hosted provider must be the selected government Meri Pehchaan service");
  if(enabled && !fs.existsSync(path.join(assets,"assets/vendor/pdfjs/pdf.worker.min.mjs")))throw new Error("Hosted PDF parser asset is missing");
  return {...config,hosted:true,allowedOrigins:[...new Set(allowedOrigins)]};
}
module.exports={hostedConfig};
