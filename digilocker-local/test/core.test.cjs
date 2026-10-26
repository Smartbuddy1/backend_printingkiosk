"use strict";
const test=require("node:test");const assert=require("node:assert/strict");const crypto=require("node:crypto");const fs=require("node:fs");const path=require("node:path");
const {makeConfig}=require("../config.cjs");const {challenge,pkce,verifyHmac,hash,RateLimiter}=require("../security.cjs");
const {Sessions,NEXT}=require("../sessions.cjs");const {normalizeDocument,boundedBytes}=require("../provider.cjs");const {validateDocument}=require("../documents.cjs");const {samplePdf}=require("../mock/pdf.cjs");const {appOverlay}=require("../integration/overlay.cjs");
const config=()=>makeConfig({DIGILOCKER_ENABLED:"true"});
test("PKCE uses the RFC 7636 Appendix B test vector and independent random verifiers",()=>{
  assert.equal(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const a=pkce(),b=pkce();assert.notEqual(a.verifier,b.verifier);assert.equal(a.challenge,challenge(a.verifier));assert.throws(()=>challenge("short"));
});
test("HMAC rejects missing, malformed, wrong-length and tampered data",()=>{
  const b=Buffer.from("sample"),secret=crypto.randomBytes(32).toString("hex"),mac=crypto.createHmac("sha256",secret).update(b).digest("base64");
  verifyHmac(b,mac,secret);
  for(const header of [null,"",mac.slice(1),"!".repeat(44),"A".repeat(43)+"="])assert.throws(()=>verifyHmac(b,header,secret),/INTEGRITY_FAILED/);
  assert.throws(()=>verifyHmac(Buffer.from("changed"),mac,secret),/INTEGRITY_FAILED/);
});
test("pair/state are single-use, cookie-bound, session-bound and independently expiring",async()=>{
  let now=1000;const store=new Sessions(config(),{now:()=>now});
  const {item,kioskSecret}=store.create("mr");assert.equal(store.kiosk(item.id,kioskSecret),item);assert.throws(()=>store.kiosk(item.id,"wrong"),/NOT_AUTHORIZED/);
  const pair=store.pair(item.pairCode);assert.equal(item.status,"PHONE_CONNECTED");assert.throws(()=>store.pair(item.pairCode),/PAIR_INVALID/);
  assert.throws(()=>store.consumeState(pair.state,"wrong.wrong"),/STATE_INVALID/);
  assert.equal(store.consumeState(pair.state,`${item.id}.${pair.phone}`),item);assert.throws(()=>store.consumeState(pair.state,`${item.id}.${pair.phone}`),/STATE_INVALID/);
  const b=store.create();const p=store.pair(b.item.pairCode);now+=store.config.pairTtl+1;
  assert.throws(()=>store.consumeState(p.state,`${b.item.id}.${p.phone}`),/STATE_INVALID/);
  const c=store.create();now+=store.config.pairTtl+1;assert.throws(()=>store.pair(c.item.pairCode),/PAIR_INVALID/);
  await store.close();
});
test("state machine rejects print before READY and completion before PRINTING",async()=>{
  const store=new Sessions(config());const {item}=store.create();assert.throws(()=>store.transition(item,"PRINTING"),/STATE_INVALID/);
  for(const next of ["PHONE_CONNECTED","DOWNLOADING","READY","PRINTING","DONE"])store.transition(item,next);
  for(const next of Object.keys(NEXT))assert.throws(()=>store.transition(item,next));await store.close();
});
test("sweeper zeroes files, cancels work, revokes tokens and removes all session indexes",async()=>{
  let now=0,revoked=[];const store=new Sessions(config(),{now:()=>now,revoke:async token=>revoked.push(token)});const {item}=store.create();store.pair(item.pairCode);
  const bytes=Buffer.from("private bytes");item.pending.push({bytes});item.token="test-token";store.reserve(item,bytes.length);
  now=item.expiresAt;await store.sweep();assert.deepEqual([...bytes],Array(bytes.length).fill(0));assert.equal(item.abort.signal.aborted,true);
  assert.deepEqual(revoked,["test-token"]);assert.equal(store.items.size+store.pairs.size+store.states.size,0);assert.equal(store.reserved,0);assert.equal(item.token,null);assert.equal(item.phoneHash,null);
});
test("limits bound session count, total memory and rate-limit maps",async()=>{
  const c=config();c.maxSessions=1;c.maxMemory=10;const store=new Sessions(c);const {item}=store.create();assert.throws(()=>store.create(),/BUSY/);assert.throws(()=>store.reserve(item,11),/BUSY/);
  const limiter=new RateLimiter(()=>0);limiter.take("x",1);assert.throws(()=>limiter.take("x",1),/RATE_LIMITED/);await store.close();
});
test("MIME lists prefer PDF and never make XML or folders printable",()=>{
  assert.equal(normalizeDocument({uri:"sample",name:"Document",mime:["application/xml",{"application/pdf":true}]}).mime,"application/pdf");
  assert.equal(normalizeDocument({uri:"sample",mime:"application/xml"}),null);assert.equal(normalizeDocument({type:"dir",uri:"sample",mime:"application/pdf"}),null);
  assert.equal(normalizeDocument({uri:"sample",mime:"IMAGE/JPG"}).mime,"image/jpeg");
});
test("stream size limits work even without Content-Length",async()=>{
  const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(4));c.enqueue(new Uint8Array(4));c.close();}}));
  await assert.rejects(boundedBytes(response,6),/FILE_TOO_LARGE/);
});
test("real vendored PDF parser counts pages and rejects invalid, oversized and over-limit input",async()=>{
  const c=config();assert.deepEqual(await validateDocument(samplePdf("Two pages",2),"application/pdf",c),{mime:"application/pdf",pages:2});
  await assert.rejects(validateDocument(Buffer.from("<html>fake</html>"),"application/pdf",c),/FILE_TYPE_INVALID/);
  await assert.rejects(validateDocument(Buffer.from("%PDF-1.4\nnot a PDF"),"application/pdf",c),/PDF_INVALID/);
  await assert.rejects(validateDocument(samplePdf("Too many",11),"application/pdf",c),/PAGE_LIMIT/);
  await assert.rejects(validateDocument(Buffer.alloc(c.maxBytes+1),"image/png",c),/FILE_TOO_LARGE/);
});
test("configuration defaults to disabled/mock; production mock, remote local-services and insecure live URLs fail closed",()=>{
  assert.equal(makeConfig({}).enabled,false);
  assert.throws(()=>makeConfig({NODE_ENV:"production"}),/local development/);
  assert.throws(()=>makeConfig({DIGILOCKER_KIOSK_BACKEND_URL:"https://example.com"}),/loopback/);
  assert.throws(()=>makeConfig({PUBLIC_BASE_URL:"http://example.com"}),/HTTPS/);
  assert.throws(()=>makeConfig({DIGILOCKER_MODE:"live",DIGILOCKER_ENABLED:"true",DIGILOCKER_LOCAL_PREVIEW:"false"}),/credentials/);
});
test("read-only UI overlays preserve original pricing/payment functions in every shipped copy",()=>{
  for(const file of [path.join(makeConfig().frontend,"app.js")]){
    const before=fs.readFileSync(file,"utf8"),digest=crypto.createHash("sha256").update(before).digest("hex");
    const after=appOverlay(before,{preview:true});assert.ok(after.includes("function digilockerOriginalResetCustomer()"));assert.ok(after.includes("async function digilockerOriginalStartLocalPrintJob()"));
    const price=/function priceDetails\(\) \{[\s\S]*?\n\}/.exec(before)[0];assert.ok(after.includes(price));
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),digest);
  }
  assert.throws(()=>appOverlay("unrecognized source"),/Unsupported kiosk source/);
});
