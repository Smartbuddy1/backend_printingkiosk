"use strict";
const { Failure, random, hash, equalHash, pkce } = require("./security.cjs");
const NEXT = Object.freeze({
  CREATED: ["PHONE_CONNECTED", "CANCELLED", "EXPIRED", "FAILED"],
  PHONE_CONNECTED: ["DOWNLOADING", "DENIED", "FAILED", "CANCELLED", "EXPIRED"],
  DOWNLOADING: ["READY", "FAILED", "CANCELLED", "EXPIRED"],
  READY: ["PRINTING", "FAILED", "CANCELLED", "EXPIRED"],
  PRINTING: ["DONE", "FAILED", "CANCELLED", "EXPIRED"],
  DONE: [], FAILED: [], DENIED: [], CANCELLED: [], EXPIRED: []
});
class Sessions {
  constructor(config, { now = Date.now, revoke = async () => {}, log = () => {} } = {}) {
    this.config = config; this.now = now; this.revoke = revoke; this.log = log;
    this.items = new Map(); this.pairs = new Map(); this.states = new Map(); this.reserved = 0;
  }
  transition(session, next) {
    if (!NEXT[session.status]?.includes(next)) throw new Failure("STATE_INVALID", 409);
    session.status = next;
    this.log({ session: session.id.slice(0, 8), state: next });
  }
  create(language = "en") {
    if (this.items.size >= this.config.maxSessions) throw new Failure("BUSY", 503);
    const id = random(24), kioskSecret = random(16), pairCode = random(24), now = this.now();
    const item = { id, kioskHash: hash(kioskSecret), pairCode, createdAt: now, expiresAt: now + this.config.sessionTtl,
      pairExpiresAt: Math.min(now + this.config.pairTtl, now + this.config.sessionTtl), language: ["en","hi","mr"].includes(language) ? language : "en",
      status: "CREATED", files: [], pending: [], documents: new Map(), token: null, abort: new AbortController(), reserved: 0, error: null };
    this.items.set(id, item); this.pairs.set(pairCode, id);
    return { item, kioskSecret };
  }
  get(id) {
    const item = this.items.get(id);
    if (!item || item.expiresAt <= this.now()) throw new Failure("SESSION_ENDED", 410);
    return item;
  }
  kiosk(id, secret) {
    const item = this.get(id);
    if (!equalHash(secret, item.kioskHash)) throw new Failure("NOT_AUTHORIZED", 401);
    return item;
  }
  pair(code) {
    const id = this.pairs.get(code);
    if (!id) throw new Failure("PAIR_INVALID", 410);
    const session = this.get(id);
    if (session.status !== "CREATED" || session.pairExpiresAt <= this.now()) throw new Failure("PAIR_INVALID", 410);
    this.pairs.delete(code); session.pairCode = null;
    const keys = pkce(); const state = random(), phone = random();
    session.verifier = keys.verifier; session.state = state; session.stateExpiresAt = Math.min(this.now() + this.config.pairTtl, session.expiresAt);
    session.phoneHash = hash(phone); session.csrf = random(); this.states.set(state, id);
    this.transition(session, "PHONE_CONNECTED");
    return { session, challenge: keys.challenge, state, phone };
  }
  phone(id, secret) {
    const session = this.get(id);
    if (!equalHash(secret, session.phoneHash)) throw new Failure("NOT_AUTHORIZED", 401);
    return session;
  }
  touchPhone(session) {
    this.alive(session);
    session.phoneActivityAt = this.now();
    session.phoneIdleExpiresAt = Math.min(session.expiresAt, this.now() + this.config.phoneIdleMs);
  }
  consumeState(value, phoneCookie) {
    const id = this.states.get(value);
    if (!id) throw new Failure("STATE_INVALID", 400);
    const [cookieId, secret] = String(phoneCookie || "").split(".");
    if (cookieId !== id) throw new Failure("STATE_INVALID", 400);
    const session = this.phone(id, secret);
    if (session.status !== "PHONE_CONNECTED" || session.stateExpiresAt <= this.now()) throw new Failure("STATE_INVALID", 400);
    this.states.delete(value); session.state = null;
    return session;
  }
  reserve(session, bytes) {
    if (session.reserved || this.reserved + bytes > this.config.maxMemory) throw new Failure("BUSY", 503);
    this.reserved += bytes; session.reserved = bytes;
  }
  alive(session) { if (this.items.get(session.id) !== session || session.abort.signal.aborted || session.expiresAt <= this.now()) throw new Failure("SESSION_ENDED", 410); }
  async revokeToken(session) {
    const token = session.token; session.token = null;
    if (token) await this.revoke(token);
  }
  clearPrivate(session) {
    session.abort.abort();
    for (const file of [...session.files, ...session.pending]) { file.bytes?.fill(0); file.bytes = null; }
    session.files = []; session.pending = []; session.documents.clear();
    if (session.pairCode) this.pairs.delete(session.pairCode);
    if (session.state) this.states.delete(session.state);
    session.pairCode = null; session.state = null; session.verifier = null; session.phoneHash = null; session.csrf = null;
    session.phoneIdleExpiresAt = null;
    this.reserved -= session.reserved; session.reserved = 0;
  }
  async end(session, status, { remove = false, code = null } = {}) {
    if (NEXT[session.status]?.length) this.transition(session, status);
    session.error = code;
    this.clearPrivate(session);
    if (remove) this.items.delete(session.id);
    try { await this.revokeToken(session); } catch { session.error = "REVOKE_FAILED"; }
  }
  async sweep() {
    await Promise.all([...this.items.values()].filter(s => s.expiresAt <= this.now() || (s.status === "PHONE_CONNECTED" && s.phoneIdleExpiresAt && s.phoneIdleExpiresAt <= this.now())).map(s => this.end(s, "EXPIRED", { remove: true })));
  }
  async close() { await Promise.all([...this.items.values()].map(s => this.end(s, "CANCELLED", { remove: true }))); }
}
module.exports = { Sessions, NEXT };
