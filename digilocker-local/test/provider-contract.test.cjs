"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Provider } = require("../provider.cjs");
const { makeConfig } = require("../config.cjs");
const { checkConfig } = require("../../tools/check-digilocker-config.cjs");

// Independent Meri Pehchaan v2.4 fixtures. HTTP stays on dynamic loopback ports.
async function fixture(t) {
  const calls = [];
  let granted = "files.uploadeddocs", malformed = false;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("/token")) return res.end(JSON.stringify({ access_token: "offline-token", token_type: "Bearer", scope: granted }));
    if (req.url.endsWith("/revoke")) return res.end();
    if (req.headers.authorization !== "Bearer offline-token") { res.statusCode = 401; return res.end("{}"); }
    if (malformed) return res.end("null");
    if (req.url.endsWith("/files/issued")) {
      if (!granted.includes("files.issueddocs")) { res.statusCode = 403; return res.end("{}"); }
      return res.end(JSON.stringify({ items: [{ uri: "issued-uri", name: "Certificate", mime: ["application/xml", "application/pdf"] }] }));
    }
    if (!granted.includes("files.uploadeddocs")) { res.statusCode = 403; return res.end("{}"); }
    return res.end(JSON.stringify({ items: req.url.endsWith("/files/") ?
      [{ type: "dir", id: "folder-1" }, { uri: "image-uri", name: "Photo", mime: "image/jpg" }] :
      [{ uri: "uploaded-uri", name: "Uploaded PDF", mime: "application/pdf" }, { type: "dir", id: "folder-1" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const config = makeConfig({ DIGILOCKER_ENABLED: "true", DIGILOCKER_MOCK_BASE_URL: `http://127.0.0.1:${server.address().port}` });
  return { provider: new Provider(config), config, calls, scope: value => { granted = value; }, malformed: () => { malformed = true; } };
}

test("uploaded-only consent lists nested documents without calling the forbidden issued endpoint", async t => {
  const f = await fixture(t);
  const grant = await f.provider.token("offline-code", "offline-verifier");
  const documents = await f.provider.list(grant.accessToken, grant.scope);
  assert.deepEqual([...documents.keys()], ["image-uri", "uploaded-uri"]);
  assert.equal(documents.get("image-uri").mime, "image/jpeg");
  assert.equal(f.calls.some(c => c.path.endsWith("/files/issued")), false);
  assert.equal(f.calls.filter(c => c.path.endsWith("/folder-1")).length, 1);
});

test("issued-only, combined and absent file scopes call only consented APIs", async t => {
  const f = await fixture(t);
  for (const [scope, expected] of [
    ["openid files.issueddocs", ["issued-uri"]],
    ["files.issueddocs files.uploadeddocs", ["issued-uri", "image-uri", "uploaded-uri"]],
    ["openid userdetails", []], ["", []]
  ]) {
    f.scope(scope); f.calls.length = 0;
    assert.deepEqual([...await f.provider.list("offline-token", scope)].map(([uri]) => uri), expected);
    if (!expected.length) assert.equal(f.calls.length, 0);
  }
});

test("OAuth requests preserve PKCE, exact callback and server-side credentials", async t => {
  const f = await fixture(t);
  const authorization = new URL(f.provider.authorize({ state: "offline-state", challenge: "offline-challenge" }));
  assert.equal(authorization.searchParams.get("scope"), "openid");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("redirect_uri"), f.config.redirectUri);
  assert.equal(authorization.searchParams.has("client_secret"), false);
  assert.equal(authorization.searchParams.get("purpose"), f.config.purpose);
  assert.equal(authorization.searchParams.get("service_name"), "Printing Kiosk");
  await f.provider.token("code+value", "verifier-value");
  const token = f.calls[0], body = new URLSearchParams(token.body);
  assert.equal(token.method, "POST");
  assert.equal(token.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(body.get("code"), "code+value");
  assert.equal(body.get("code_verifier"), "verifier-value");
  assert.equal(body.get("redirect_uri"), f.config.redirectUri);
  assert.equal(body.get("client_secret"), f.config.clientSecret);
  await f.provider.revoke("offline-token");
  const revoke = f.calls.at(-1);
  assert.equal(revoke.headers.authorization, "Basic " + Buffer.from(f.config.clientId + ":" + f.config.clientSecret).toString("base64"));
  assert.equal(new URLSearchParams(revoke.body).get("token_type_hint"), "access_token");
});

test("malformed document lists produce a controlled provider error", async t => {
  const f = await fixture(t); f.malformed();
  for (const scope of ["files.issueddocs", "files.uploadeddocs"]) {
    await assert.rejects(f.provider.list("offline-token", scope), { code: "PROVIDER_RESPONSE_INVALID" });
  }
});

const live = {
  DIGILOCKER_MODE: "live", DIGILOCKER_ENABLED: "true",
  PUBLIC_BASE_URL: "https://api.example.test",
  DIGILOCKER_REDIRECT_URI: "https://api.example.test/digilocker/callback",
  DIGILOCKER_ALLOWED_ORIGINS: "https://kiosk.example.test",
  DIGILOCKER_KIOSK_BACKEND_URL: "http://127.0.0.1:5080",
  DIGILOCKER_CLIENT_ID: "offline-id", DIGILOCKER_CLIENT_SECRET: "offline-secret"
};
test("activation preflight rejects missing backend, placeholders and callback or document-type mistakes", () => {
  const check = env => checkConfig(env, { hosted: true });
  assert.equal(check(live).mode, "live");
  for (const extra of [
    { DIGILOCKER_KIOSK_BACKEND_URL: "" }, { DIGILOCKER_KIOSK_BACKEND_URL: "https://remote.test" },
    { DIGILOCKER_CLIENT_ID: "PASTE_APPROVED_CLIENT_ID" }, { DIGILOCKER_CLIENT_SECRET: " " },
    { DIGILOCKER_CLIENT_SECRET: "offline-secret\n" }, { DIGILOCKER_ENABLED: "false" },
    { DIGILOCKER_REDIRECT_URI: "https://api.example.test/wrong" },
    { DIGILOCKER_REQ_DOCTYPES: "PANCR DRVLC" }
  ]) assert.throws(() => check({ ...live, ...extra }));
  assert.equal(check({ ...live, DIGILOCKER_REQ_DOCTYPES: "PANCR,DRVLC" }).reqDoctypes, "PANCR,DRVLC");
});
