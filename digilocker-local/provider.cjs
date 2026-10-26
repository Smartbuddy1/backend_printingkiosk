"use strict";
const { Failure, safeText, verifyHmac } = require("./security.cjs");
const { validateDocument } = require("./documents.cjs");

async function boundedBytes(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) { await response.body?.cancel(); throw new Failure("FILE_TOO_LARGE", 413); }
  const chunks = []; let total = 0;
  try {
    for await (const chunk of response.body || []) {
      total += chunk.length;
      if (total > maxBytes) throw new Failure("FILE_TOO_LARGE", 413);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
function mimeValues(value, depth = 0) {
  if (depth > 3) return [];
  if (typeof value === "string") return value.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(v => mimeValues(v, depth + 1));
  if (value && typeof value === "object") return [...Object.keys(value), ...Object.values(value)].flatMap(v => mimeValues(v, depth + 1));
  return [];
}
function normalizeDocument(item) {
  if (!item || item.type === "dir" || typeof item.uri !== "string") return null;
  const uri = item.uri.trim();
  if (!uri || uri.length > 1024 || /[\u0000-\u001f\u007f]/.test(uri)) return null;
  const types = mimeValues(item.mime).map(m => m === "image/jpg" ? "image/jpeg" : m);
  const mime = ["application/pdf", "image/jpeg", "image/png"].find(m => types.includes(m));
  if (!mime) return null;
  return { uri, mime, name: safeText(item.name || "Document"), issuer: safeText(item.issuer),
    type: safeText(item.doctype || item.description || "Document", 80), date: safeText(item.date, 60) };
}
class Provider {
  constructor(config) { this.config = config; }
  authorize({ state, challenge }) {
    const c = this.config, u = new URL(c.lanDemo ? `${c.publicBase}/__mock-provider/public/oauth2/1/authorize` : c.endpoints.authorize);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: c.clientId, redirect_uri: c.redirectUri,
      state, scope: "openid", code_challenge: challenge, code_challenge_method: "S256", purpose: c.purpose, service_name: c.serviceName })) u.searchParams.set(key, value);
    if (c.reqDoctypes) u.searchParams.set("req_doctype", c.reqDoctypes);
    return u.href;
  }
  async request(url, options = {}, maxBytes = 1024 * 1024) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.config.requestTimeout)]) : AbortSignal.timeout(this.config.requestTimeout);
    let response;
    try {
      response = await fetch(url, { ...options, signal, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        const code = ({400:"PROVIDER_REQUEST_REJECTED",401:"TOKEN_EXPIRED",403:"CONSENT_REQUIRED",404:"DOCUMENT_UNAVAILABLE"})[response.status] || "PROVIDER_UNAVAILABLE";
        throw new Failure(code, response.status < 500 ? 400 : 502);
      }
      const bytes = await boundedBytes(response, maxBytes);
      return { bytes, headers: response.headers };
    } catch (error) { if (error instanceof Failure) throw error; throw new Failure(options.signal?.aborted ? "SESSION_ENDED" : "PROVIDER_UNAVAILABLE", 502); }
  }
  async json(url, options) {
    const { bytes } = await this.request(url, options);
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Failure("PROVIDER_RESPONSE_INVALID", 502); } finally { bytes.fill(0); }
  }
  async token(code, verifier, signal) {
    const c = this.config;
    const data = await this.json(c.endpoints.token, { method: "POST", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: c.redirectUri, code_verifier: verifier, client_id: c.clientId, client_secret: c.clientSecret }) });
    if (typeof data.access_token !== "string" || !data.access_token || data.access_token.length > 8192 || String(data.token_type).toLowerCase() !== "bearer") throw new Failure("PROVIDER_RESPONSE_INVALID", 502);
    // Intentionally discard id_token, refresh token and all account/identity fields.
    return { accessToken: data.access_token, scope: typeof data.scope === "string" ? data.scope : "" };
  }
  async list(token, scope, signal) {
    const headers = { Authorization: `Bearer ${token}` };
    const issued = await this.json(this.config.endpoints.issued, { headers, signal });
    if (!Array.isArray(issued.items) || issued.items.length > 1000) throw new Failure("PROVIDER_RESPONSE_INVALID", 502);
    const docs = issued.items.map(normalizeDocument).filter(Boolean);
    if (scope.split(/\s+/).includes("files.uploadeddocs")) {
      const queue = [""], seen = new Set();
      while (queue.length && seen.size < 20 && docs.length < 1000) {
        const id = queue.shift(); if (seen.has(id)) continue; seen.add(id);
        const data = await this.json(this.config.endpoints.uploaded + encodeURIComponent(id), { headers, signal });
        if (!Array.isArray(data.items) || data.items.length > 1000) throw new Failure("PROVIDER_RESPONSE_INVALID", 502);
        for (const item of data.items) {
          if (item?.type === "dir" && typeof item.id === "string" && item.id.length <= 256 && queue.length < 20) queue.push(item.id);
          else { const doc = normalizeDocument(item); if (doc) docs.push(doc); }
        }
      }
    }
    return new Map(docs.slice(0, 1000).map(d => [d.uri, d]));
  }
  async download(doc, token, signal) {
    const { bytes, headers } = await this.request(this.config.endpoints.file + encodeURIComponent(doc.uri), {
      headers: { Authorization: `Bearer ${token}`, Accept: doc.mime }, signal
    }, this.config.maxBytes);
    try {
      verifyHmac(bytes, headers.get("hmac"), this.config.clientSecret);
      const { mime, pages } = await validateDocument(bytes, headers.get("content-type"), this.config, signal);
      if (mime !== doc.mime) throw new Failure("FILE_TYPE_INVALID", 415);
      return { bytes, mime, pages, size: bytes.length, name: doc.name };
    } catch (error) { bytes.fill(0); throw error; }
  }
  async revoke(token) {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.request(this.config.endpoints.revoke, { method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64") },
          body: new URLSearchParams({ token, token_type_hint: "access_token" }) });
        result.bytes.fill(0); return;
      } catch (error) { last = error; }
    }
    throw new Failure("REVOKE_FAILED", last?.status || 502);
  }
}
module.exports = { Provider, boundedBytes, normalizeDocument };
