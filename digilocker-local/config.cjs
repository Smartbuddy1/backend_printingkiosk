"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_PATHS = Object.freeze({
  authorize: "/public/oauth2/1/authorize", token: "/public/oauth2/2/token",
  issued: "/public/oauth2/2/files/issued", uploaded: "/public/oauth2/1/files/",
  file: "/public/oauth2/1/file/", revoke: "/public/oauth2/1/revoke", logout: "/signin/logout/Y"
});
function localHost(host) { return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host); }
function privateIPv4(host) {
  if (require("node:net").isIP(host) !== 4) return false;
  const [a,b] = host.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function number(env, key, fallback, min, max) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}
function loadLocalEnv(file = path.join(__dirname, ".env")) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || (!match[1].startsWith("DIGILOCKER_") && !["PUBLIC_BASE_URL", "NODE_ENV"].includes(match[1]))) continue;
    values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}
function makeConfig(env = {}) {
  const mode = env.DIGILOCKER_MODE || "mock";
  if (!["mock", "live"].includes(mode)) throw new Error("DIGILOCKER_MODE must be mock or live");
  if (mode === "mock" && ["production", "prod"].includes(String(env.NODE_ENV).toLowerCase())) throw new Error("Mock mode is local development only");
  const port = number(env, "DIGILOCKER_PORT", 5081, 0, 65535);
  const mockPort = number(env, "DIGILOCKER_MOCK_PORT", 5082, 0, 65535);
  const preview = env.DIGILOCKER_LOCAL_PREVIEW !== "false";
  const lanDemo = env.DIGILOCKER_LAN_DEMO === "true";
  const listenHost = lanDemo ? String(env.DIGILOCKER_LAN_HOST || "") : "127.0.0.1";
  if (lanDemo && (mode !== "mock" || !preview || !privateIPv4(listenHost))) throw new Error("Wi-Fi demo requires mock mode, simulated printing and a private IPv4 address");
  const localOrigin = `http://${listenHost}:${port}`;
  const publicBase = new URL(env.PUBLIC_BASE_URL || localOrigin);
  if (publicBase.username || publicBase.password || publicBase.search || publicBase.hash || publicBase.pathname !== "/") throw new Error("PUBLIC_BASE_URL must be an origin");
  if (publicBase.protocol !== "https:" && !(publicBase.protocol === "http:" && (localHost(publicBase.hostname) || (lanDemo && publicBase.origin === localOrigin)))) throw new Error("PUBLIC_BASE_URL requires HTTPS (explicit mock Wi-Fi demo and loopback excepted)");
  if (lanDemo && publicBase.origin !== localOrigin) throw new Error("Wi-Fi demo public origin must match its private listener");
  const enabled = env.DIGILOCKER_ENABLED === "true";
  const base = new URL(mode === "mock" ? (env.DIGILOCKER_MOCK_BASE_URL || `http://127.0.0.1:${mockPort}`) : (env.DIGILOCKER_BASE_URL || "https://digilocker.meripehchaan.gov.in"));
  if (mode === "mock" && (!localHost(base.hostname) || base.protocol !== "http:")) throw new Error("Mock provider must be on loopback");
  if (mode === "live" && base.protocol !== "https:") throw new Error("Live provider requires HTTPS");
  const clientId = mode === "mock" ? crypto.randomBytes(16).toString("hex") : (env.DIGILOCKER_CLIENT_ID || "");
  const clientSecret = mode === "mock" ? crypto.randomBytes(32).toString("hex") : (env.DIGILOCKER_CLIENT_SECRET || "");
  const purpose = env.DIGILOCKER_PURPOSE || "Print selected documents at kiosk";
  const serviceName = env.DIGILOCKER_SERVICE_NAME || "Printing Kiosk";
  for (const value of [purpose, serviceName]) if (!/^[A-Za-z0-9_ ]{1,160}$/.test(value)) throw new Error("Purpose and service name require letters, numbers, spaces or underscores");
  if (enabled && mode === "live" && (!clientId || !clientSecret || !env.DIGILOCKER_REDIRECT_URI)) throw new Error("Live mode requires client credentials and the registered redirect URI");
  if (mode === "live" && publicBase.protocol !== "https:") throw new Error("Live DigiLocker requires an HTTPS public callback origin");
  const redirectUri = env.DIGILOCKER_REDIRECT_URI || `${publicBase.origin}/digilocker/callback`;
  const redirect = new URL(redirectUri);
  if (redirect.origin !== publicBase.origin || redirect.pathname !== "/digilocker/callback" || redirect.search || redirect.hash) throw new Error("Redirect URI must exactly match PUBLIC_BASE_URL/digilocker/callback");
  const endpoints = {};
  for (const [key, value] of Object.entries(DEFAULT_PATHS)) {
    const u = new URL(env[`DIGILOCKER_${key.toUpperCase()}_URL`] || value, base);
    if (u.origin !== base.origin || u.username || u.password || u.search || u.hash) throw new Error(`Invalid ${key} endpoint origin`);
    endpoints[key] = u.href;
  }
  // Review exports keep the frontend and backend in sibling checkout folders.
  // The version workspace continues to use its own frontend directory.
  const defaultFrontend = fs.existsSync(path.join(ROOT, "frontend", "app.js")) ? "frontend" : "../frontend";
  const frontend = path.resolve(ROOT, env.DIGILOCKER_FRONTEND_DIR || defaultFrontend);
  if (!fs.existsSync(path.join(frontend, "app.js")) || !fs.existsSync(path.join(frontend, "index.html"))) throw new Error("DIGILOCKER_FRONTEND_DIR must contain the existing app.js and index.html");
  if (preview && mode !== "mock") throw new Error("Live mode cannot use simulated payment/printing");
  if (!preview && (!env.DIGILOCKER_KIOSK_ID || ["LOCAL-KIOSK","UNASSIGNED-KIOSK"].includes(env.DIGILOCKER_KIOSK_ID))) throw new Error("Real printing requires the explicit local test kiosk ID");
  function localService(key, fallback) {
    const u = new URL(env[key] || fallback);
    if (!localHost(u.hostname) || u.protocol !== "http:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error(`${key} must be a loopback origin`);
    return u.origin;
  }
  return {
    enabled, mode, port, mockPort, localOrigin, publicBase: publicBase.origin, redirectUri, lanDemo, listenHost,
    endpoints, clientId, clientSecret, purpose, serviceName, frontend, preview,
    backend: localService("DIGILOCKER_KIOSK_BACKEND_URL", "http://127.0.0.1:5080"),
    agent: localService("DIGILOCKER_KIOSK_AGENT_URL", "http://127.0.0.1:5079"),
    kioskId: env.DIGILOCKER_KIOSK_ID || "LOCAL-KIOSK",
    reqDoctypes: env.DIGILOCKER_REQ_DOCTYPES || "",
    pairTtl: number(env, "DIGILOCKER_PAIR_TTL_MINUTES", 3, 0.01, 10) * 60000,
    sessionTtl: number(env, "DIGILOCKER_SESSION_TTL_MINUTES", 10, 0.02, 30) * 60000,
    phoneIdleMs: number(env, "DIGILOCKER_PHONE_IDLE_SECONDS", 120, 1, 600) * 1000,
    maxFiles: Math.floor(number(env, "DIGILOCKER_MAX_FILES", 5, 1, 10)),
    maxBytes: number(env, "DIGILOCKER_MAX_FILE_MB", 10, 0.001, 10) * 1024 * 1024,
    maxMemory: number(env, "DIGILOCKER_MAX_MEMORY_MB", 100, 1, 512) * 1024 * 1024,
    maxSessions: Math.floor(number(env, "DIGILOCKER_MAX_SESSIONS", 20, 1, 100)),
    requestTimeout: 15000, maxPages: 10
  };
}
module.exports = { makeConfig, loadLocalEnv, localHost, privateIPv4, DEFAULT_PATHS, ROOT };
