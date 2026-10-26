"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { random, hash, equalHash, challenge, Failure, readBody, escapeHtml: h, RateLimiter } = require("../security.cjs");
const { shell } = require("../phone-pages.cjs");
const { translator } = require("../i18n.cjs");
const { samplePdf } = require("./pdf.cjs");
function createMock(config, { now = Date.now, fault = null } = {}) {
  if (config.mode !== "mock" || process.env.NODE_ENV === "production") throw new Error("Mock provider is local development only");
  const requests = new Map(), codes = new Map(), tokens = new Map(), limiter = new RateLimiter(now);
  const audit = { tokensIssued: 0, revoked: 0, downloads: 0 };
  function json(res, status, body) { res.writeHead(status, { "content-type":"application/json", "cache-control":"no-store" }); res.end(JSON.stringify(body)); }
  function documentSet() {
    const nonce = random(8);
    return [
      { uri:`sample-course-${nonce}`, name:"Sample Course Certificate", type:"file", mime:["application/pdf","application/xml"], doctype:"SAMPLE", issuer:"Local Sample College", date:"2026-01-15", pages:2, source:"issued" },
      { uri:`sample-letter-${nonce}`, name:"Sample Letter", type:"file", mime:"application/pdf", doctype:"SAMPLE", issuer:"Local Sample Office", date:"2026-02-01", pages:1, source:"issued" },
      { uri:`sample-upload-${nonce}`, name:"Sample Uploaded Note", type:"file", mime:"application/pdf", issuer:"", date:"2026-03-01", pages:1, source:"uploaded" }
    ];
  }
  const server = http.createServer(async (req, res) => {
    // Browser-facing demo actions use the feature service on Wi-Fi. The mock
    // token/document endpoints remain bound to loopback and are never proxied.
    const originalEnd = res.end.bind(res);
    res.end = (value, ...args) => originalEnd(config.lanDemo && typeof value === "string" ? value.replace('action="/mock/consent"', 'action="/__mock-provider/mock/consent"') : value, ...args);
    res.setHeader("Cache-Control","no-store"); res.setHeader("X-Content-Type-Options","nosniff"); res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self' ${new URL(config.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`);
    try {
      limiter.take(req.socket.remoteAddress || "unknown", 240);
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && ["/digilocker/phone.css","/digilocker/phone.js"].includes(url.pathname)) { const js=url.pathname.endsWith(".js");res.writeHead(200,{"content-type":js?"text/javascript":"text/css"}); return res.end(fs.readFileSync(path.join(__dirname,js?"../public/phone.js":"../public/phone.css"))); }
      if (req.method === "GET" && url.pathname === "/public/oauth2/1/authorize") {
        if (url.searchParams.get("client_id") !== config.clientId || url.searchParams.get("redirect_uri") !== config.redirectUri || url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") || "") || !url.searchParams.get("purpose") || !url.searchParams.get("service_name")) throw new Failure("invalid_request");
        const state = url.searchParams.get("state"); if (!/^[A-Za-z0-9_-]{32,128}$/.test(state || "")) throw new Failure("invalid_request");
        const id = random(), csrf = random(), language = ["hi","mr"].includes(url.searchParams.get("language")) ? url.searchParams.get("language") : "en";
        requests.set(id,{ state, challenge:url.searchParams.get("code_challenge"), expires:now()+config.pairTtl, csrfHash:hash(csrf) });
        const t=translator(language);
        res.writeHead(200,{"content-type":"text/html; charset=utf-8"});
        return res.end(shell(language, "Mock DigiLocker consent", `<p>${h(t("mockAccount"))}</p><p><strong>Sample Course Certificate · PDF<br>Sample Letter · PDF<br>Sample Uploaded Note · PDF</strong></p><form method="post" action="/mock/consent"><input type="hidden" name="request" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="allow">${h(t("allow"))}</button><button name="decision" value="deny" class="secondary">${h(t("deny"))}</button></form>`, true, true).replace("<body>", `<body data-phone-page-expiry="${now()+config.pairTtl}">`));
      }
      if (req.method === "POST" && url.pathname === "/mock/consent") {
        const body = await readBody(req), entry = requests.get(body.request);
        if (!entry || entry.expires <= now() || !equalHash(body.csrf,entry.csrfHash)) throw new Failure("invalid_request");
        requests.delete(body.request); const next = new URL(config.redirectUri); next.searchParams.set("state",entry.state);
        if (body.decision === "deny") next.searchParams.set("error","access_denied");
        else if (body.decision === "allow") { const code=random(); codes.set(code,entry); next.searchParams.set("code",code); }
        else throw new Failure("invalid_request");
        res.writeHead(303,{Location:next.href}); return res.end();
      }
      if (req.method === "POST" && url.pathname === "/public/oauth2/2/token") {
        const body=await readBody(req), entry=codes.get(body.code); codes.delete(body.code);
        if (body.client_id !== config.clientId || !equalHash(body.client_secret,hash(config.clientSecret))) throw new Failure("invalid_client",401);
        if (!entry || entry.expires <= now() || body.grant_type !== "authorization_code" || body.redirect_uri !== config.redirectUri || challenge(body.code_verifier) !== entry.challenge) throw new Failure("invalid_grant");
        const token=random(); tokens.set(token,{ documents:documentSet(), expires:now()+config.sessionTtl }); audit.tokensIssued++;
        return json(res,200,{ access_token:token, token_type:"Bearer", expires_in:Math.floor(config.sessionTtl/1000), scope:"openid files.issueddocs files.uploadeddocs" });
      }
      if (req.method === "POST" && url.pathname === "/public/oauth2/1/revoke") {
        const expected="Basic "+Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
        if (!equalHash(req.headers.authorization,hash(expected))) throw new Failure("invalid_client",401);
        const body=await readBody(req); if(tokens.delete(body.token)) audit.revoked++;
        return json(res,200,{});
      }
      const token = String(req.headers.authorization || "").replace(/^Bearer /,""), grant=tokens.get(token);
      if (!grant || grant.expires <= now()) throw new Failure("invalid_token",401);
      if (req.method === "GET" && ["/public/oauth2/2/files/issued","/public/oauth2/1/files/"].includes(url.pathname)) {
        const source=url.pathname.endsWith("issued")?"issued":"uploaded";
        return json(res,200,{items:grant.documents.filter(d=>d.source===source).map(({pages,source,...doc})=>doc)});
      }
      if (req.method === "GET" && url.pathname.startsWith("/public/oauth2/1/file/")) {
        const uri=decodeURIComponent(url.pathname.slice("/public/oauth2/1/file/".length)); const doc=grant.documents.find(d=>d.uri===uri);
        if(!doc) throw new Failure("invalid_uri",404);
        audit.downloads++;
        const bytes=samplePdf(doc.name,doc.pages);
        const hmac=crypto.createHmac("sha256",config.clientSecret).update(bytes).digest("base64");
        const response={ bytes, mime:"application/pdf", hmac }; if(fault) await fault(response);
        const headers={"content-type":response.mime,"content-length":response.bytes.length}; if(response.hmac !== null) headers.hmac=response.hmac;
        res.writeHead(200,headers); return res.end(response.bytes);
      }
      throw new Failure("not_found",404);
    } catch(error) { if(!res.headersSent) json(res,error.status || 500,{error:error instanceof Failure ? error.code : "unexpected_error"}); else res.destroy(); }
  });
  const sweeper=setInterval(()=>{for(const map of [requests,codes,tokens])for(const [key,value] of map)if(value.expires<=now())map.delete(key);},60000);sweeper.unref();
  server.on("close",()=>{clearInterval(sweeper);requests.clear();codes.clear();tokens.clear();});
  return {server,audit,tokens};
}
module.exports={createMock};
