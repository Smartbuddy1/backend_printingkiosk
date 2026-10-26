"use strict";
const crypto = require("node:crypto");
class Failure extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const hash = value => crypto.createHash("sha256").update(String(value)).digest();
function equalHash(value, digest) { return typeof value === "string" && value.length <= 1024 && Buffer.isBuffer(digest) && crypto.timingSafeEqual(hash(value), digest); }
function challenge(verifier) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier || "")) throw new Failure("PKCE_INVALID");
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}
function pkce() { const verifier = random(); return { verifier, challenge: challenge(verifier) }; }
function verifyHmac(bytes, header, secret) {
  if (typeof header !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(header)) throw new Failure("INTEGRITY_FAILED", 502);
  const given = Buffer.from(header, "base64");
  const expected = crypto.createHmac("sha256", secret).update(bytes).digest();
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new Failure("INTEGRITY_FAILED", 502);
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch])); }
function safeText(value, length = 160) { return String(value || "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, length); }
async function readBody(req, limit = 16384) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Failure("REQUEST_TOO_LARGE", 413); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw); const data = Object.fromEntries(params); data.uris = params.getAll("uris"); return data;
  }
  if (!raw) return {};
  if (!(req.headers["content-type"] || "").startsWith("application/json")) throw new Failure("CONTENT_TYPE_INVALID", 415);
  try { const value = JSON.parse(raw); if (!value || Array.isArray(value) || typeof value !== "object") throw 0; return value; } catch { throw new Failure("REQUEST_INVALID"); }
}
function cookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) { const at = part.indexOf("="); if (at > 0) result[part.slice(0, at).trim()] = part.slice(at + 1).trim(); }
  return result;
}
class RateLimiter {
  constructor(now = Date.now) { this.entries = new Map(); this.now = now; }
  take(key, limit, windowMs = 60000) {
    const now = this.now(); let entry = this.entries.get(key);
    if (!entry || entry.until <= now) { entry = { count: 0, until: now + windowMs }; this.entries.set(key, entry); }
    if (++entry.count > limit) throw new Failure("RATE_LIMITED", 429);
    if (this.entries.size > 2000) for (const [k,v] of this.entries) if (v.until <= now) this.entries.delete(k);
    if (this.entries.size > 4000) throw new Failure("BUSY", 503);
  }
}
module.exports = { Failure, random, hash, equalHash, challenge, pkce, verifyHmac, escapeHtml, safeText, readBody, cookies, RateLimiter };
