"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http");
const {hostedConfig}=require("../config.cjs");
const {createService}=require("../../digilocker-local/server.cjs");
const {Provider}=require("../../digilocker-local/provider.cjs");
const {requireKioskEnabled}=require("../../digilocker-local/kiosk-policy.cjs");
const {parserPreflight}=require("../preflight.cjs");
test("hosted readiness exercises the real PDF worker and rejects unavailable parser assets",async()=>{
  await parserPreflight({frontend:require("node:path").join(__dirname,"..")});
  await assert.rejects(parserPreflight({frontend:require("node:path").join(__dirname,"missing-parser")}),{code:"PDF_PARSER_UNAVAILABLE"});
});
const env={PUBLIC_BASE_URL:"https://api.example.test",DIGILOCKER_ALLOWED_ORIGINS:"https://kiosk.example.test",DIGILOCKER_PORT:"0",DIGILOCKER_KIOSK_BACKEND_URL:"http://127.0.0.1:5080"};
const origin="https://kiosk.example.test";
async function setup(t,enabled=false,options={}){
  const config=hostedConfig({...env,...(enabled?{DIGILOCKER_ENABLED:"true",DIGILOCKER_CLIENT_ID:"offline-test",DIGILOCKER_CLIENT_SECRET:"offline-test",DIGILOCKER_REDIRECT_URI:env.PUBLIC_BASE_URL+"/digilocker/callback"}:{})});
  const audit={tokens:0,revoked:0};
  config.pdfUnlock=Boolean(options.encrypted);
  const provider={authorize:p=>new Provider(config).authorize(p),token:async()=>{audit.tokens++;return {accessToken:"offline-token",scope:"openid"};},list:async()=>new Map([["test-uri",{uri:"test-uri",name:"Test",mime:"application/pdf"}]]),download:async()=>({name:"Test",mime:"application/pdf",pages:1,size:5,bytes:Buffer.from("%PDF-")}),revoke:async()=>{audit.revoked++;}};
  const policies=new Map([["KIOSK-ON",true],["KIOSK-OFF",false]]);
  if(options.encrypted)provider.download=async()=>({name:"Protected test",mime:"application/pdf",pages:null,size:5,bytes:Buffer.from("%PDF-"),encrypted:true});
  const logs=[];
  const app=createService(config,{provider,log:entry=>logs.push(entry),unlockPdf:options.unlockPdf||(async(bytes,password)=>{
    if(password!=="test-customer-password")throw new (require("../../digilocker-local/security.cjs").Failure)("PDF_PASSWORD_INCORRECT");
    return {bytes:Buffer.from("%PDF-opened"),mime:"application/pdf",size:11,pages:1};
  }),kioskPolicy:id=>requireKioskEnabled(config,id,async url=>{
    const kioskId=new URL(url).searchParams.get("kioskId");
    return new Response(JSON.stringify({kiosk:policies.has(kioskId)?{kioskId,customerSettings:{digilocker:policies.get(kioskId)}}:null}));
  })});
  await new Promise(r=>app.server.listen(0,"127.0.0.1",r));t.after(()=>app.close());
  function request(path,{method="GET",headers={},body}={}){return new Promise((resolve,reject)=>{
    const req=http.request({hostname:"127.0.0.1",port:app.server.address().port,path,method,headers:{Host:"api.example.test",...headers}},res=>{const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)});});});req.on("error",reject);req.end(body);
  });}
  async function create(){const bootstrap=await request("/api/digilocker/bootstrap",{headers:{Origin:origin}});assert.equal(bootstrap.status,200);const key=bootstrap.json().kioskKey;const headers={Origin:origin,"Content-Type":"application/json","X-Digilocker-Kiosk-Key":key};const result=await request("/api/digilocker/sessions",{method:"POST",headers,body:'{"language":"en","kioskId":"KIOSK-ON"}'});assert.equal(result.status,201);return {...result.json(),createHeaders:headers};}
  return {app,audit,request,create,config,policies,logs};
}

async function protectedPhone(t,options={}){
  const s=await setup(t,true,{encrypted:true,...options}),a=await s.create();
  const start=await s.request(new URL(a.qrUrl).pathname),cookie=start.headers["set-cookie"][0].split(";")[0];
  const state=new URL(start.headers.location).searchParams.get("state");
  await s.request("/digilocker/callback?code=test&state="+state,{headers:{Cookie:cookie}});
  const item=s.app.store.items.get(a.sessionId),base="/api/digilocker/sessions/"+a.sessionId;
  const headers={Origin:env.PUBLIC_BASE_URL,Cookie:cookie,"Content-Type":"application/json"};
  const result=await s.request(base+"/select",{method:"POST",headers,body:JSON.stringify({csrf:item.csrf,uris:["test-uri"]})});
  assert.equal(result.json().status,"PASSWORD_REQUIRED");assert.equal(s.audit.revoked,1);assert.equal(item.token,null);
  const unlock=(password,extra={})=>s.request(base+"/unlock",{method:"POST",headers,body:JSON.stringify({csrf:item.csrf,fileId:item.pending[0]?.fileId,password,...extra})});
  return {...s,a,item,base,headers,unlock,cookie};
}
test("protected phone flow retries a wrong password, blocks forged input and hands off only unlocked bytes",async t=>{
  const s=await protectedPhone(t),encrypted=s.item.pending[0].bytes;
  assert.match((await s.request("/digilocker/unlock",{headers:{Cookie:s.cookie}})).text,/type="password"/);
  assert.equal((await s.unlock("test-customer-password",{csrf:"forged"})).status,403);
  assert.equal((await s.unlock("test-customer-password",{fileId:"forged"})).status,403);
  const wrong=await s.unlock("private-wrong-password");assert.equal(wrong.json().error,"PDF_PASSWORD_INCORRECT");assert.equal(s.item.status,"DOWNLOADING");
  assert.equal((await s.request(s.base+"/files/"+s.item.pending[0].fileId,{headers:{Origin:origin,"X-Kiosk-Secret":s.a.kioskSecret}})).status,409);
  const ok=await s.unlock("test-customer-password");assert.equal(ok.json().status,"READY");assert.equal(s.item.files[0].bytes.toString(),"%PDF-opened");assert.ok(encrypted.every(v=>v===0));
  assert.ok(!JSON.stringify(s.logs).includes("password"));assert.ok(!JSON.stringify(s.item).includes("test-customer-password"));
  const bytes=s.item.files[0].bytes;await s.app.store.end(s.item,"CANCELLED");assert.ok(bytes.every(v=>v===0));assert.equal(s.app.store.reserved,0);
});
test("five wrong PDF passwords end the session and erase retained ciphertext",async t=>{
  const s=await protectedPhone(t),bytes=s.item.pending[0].bytes;
  for(let i=0;i<5;i++)assert.equal((await s.unlock("wrong")).status,400);
  assert.equal(s.item.status,"FAILED");assert.equal(s.item.phoneHash,null);assert.ok(bytes.every(v=>v===0));assert.equal(s.app.store.reserved,0);
});
test("password-wait inactivity erases ciphertext without storing a password",async t=>{
  const s=await protectedPhone(t),bytes=s.item.pending[0].bytes;
  s.item.phoneIdleExpiresAt=Date.now()-1;await s.app.store.sweep();
  assert.ok(bytes.every(v=>v===0));assert.equal(s.app.store.items.has(s.item.id),false);
});
test("cancellation during PDF unlock cannot resurrect document access",async t=>{
  let resume,started;const running=new Promise(resolve=>started=resolve);const opened=Buffer.from("%PDF-opened");
  const s=await protectedPhone(t,{unlockPdf:async()=>{started();await new Promise(resolve=>resume=resolve);return {bytes:opened,pages:1,mime:"application/pdf",size:opened.length};}});
  const request=s.unlock("test-customer-password");await running;await s.app.store.end(s.item,"CANCELLED",{remove:true});resume();await request;
  assert.ok(opened.every(v=>v===0));assert.equal(s.item.files.length,0);assert.equal(s.app.store.reserved,0);
});
test("hosted configuration rejects mock, HTTP, unapproved activation and foreign provider",()=>{
  for(const extra of [{DIGILOCKER_MODE:"mock"},{PUBLIC_BASE_URL:"http://api.example.test"},{DIGILOCKER_ENABLED:"true"},{DIGILOCKER_LOCAL_PREVIEW:"true"},{DIGILOCKER_BASE_URL:"https://other.example.test"},{DIGILOCKER_ALLOWED_ORIGINS:"https://kiosk.example.test/path"}])assert.throws(()=>hostedConfig({...env,...extra}));
});
test("deployed callback is truthful and cannot authenticate while approval is pending",async t=>{
  const s=await setup(t);const page=await s.request("/digilocker/callback");assert.equal(page.status,200);assert.match(page.text,/awaiting approved credentials/);
  const query=await s.request("/digilocker/callback?code=private-code&state=private-state");assert.equal(query.status,503);assert.ok(!query.text.includes("private-code"));
  const health=(await s.request("/digilocker/health")).json();assert.equal(health.ready,false);assert.equal(health.mode,"live");
  const bootstrap=await s.request("/api/digilocker/bootstrap",{headers:{Origin:origin}});assert.equal(bootstrap.status,503);assert.equal(bootstrap.json().error,"DIGILOCKER_NOT_READY");assert.equal(bootstrap.headers["access-control-allow-origin"],origin);assert.equal(s.audit.tokens,0);
});
test("host and origin checks, CORS and one-use browser session bootstrap",async t=>{
  const s=await setup(t,true);
  assert.equal((await s.request("/digilocker/health",{headers:{Host:"evil.test"}})).status,403);
  assert.equal((await s.request("/api/digilocker/bootstrap")).status,403);
  assert.equal((await s.request("/api/digilocker/bootstrap",{headers:{Origin:"https://evil.test"}})).status,403);
  assert.equal((await s.request("/api/digilocker/sessions",{method:"OPTIONS",headers:{Origin:origin}})).status,204);
  const a=await s.create();assert.ok(!a.qrUrl.includes(a.kioskSecret));
  assert.equal((await s.request("/api/digilocker/sessions",{method:"POST",headers:a.createHeaders,body:"{}"})).status,401);
  const status="/api/digilocker/sessions/"+a.sessionId+"/status";
  assert.equal((await s.request(status,{headers:{Origin:origin}})).status,401);
  assert.equal((await s.request(status,{headers:{Origin:origin,"X-Kiosk-Secret":a.kioskSecret}})).status,200);
  for(const path of ["/digilocker/runtime.js","/.env","/app.js"])assert.equal((await s.request(path,{headers:{Origin:origin}})).status,404);
});
test("hosted callback binds phone cookie and state, allows phone status and erases selected bytes",async t=>{
  const s=await setup(t,true),a=await s.create();const start=await s.request(new URL(a.qrUrl).pathname);
  assert.equal(start.status,302);const cookie=start.headers["set-cookie"][0].split(";")[0];assert.match(start.headers["set-cookie"][0],/Secure/);
  const authorization=new URL(start.headers.location);assert.equal(authorization.searchParams.get("code_challenge_method"),"S256");
  const callback="/digilocker/callback?code=offline-code&state="+authorization.searchParams.get("state");
  assert.equal((await s.request(callback)).status,400);assert.equal(s.audit.tokens,0);
  assert.equal((await s.request(callback,{headers:{Cookie:cookie}})).status,303);assert.equal(s.audit.tokens,1);
  assert.equal((await s.request(callback,{headers:{Cookie:cookie}})).status,400);
  const base="/api/digilocker/sessions/"+a.sessionId;
  assert.equal((await s.request(base+"/phone-status",{headers:{Cookie:cookie}})).status,200);
  const item=s.app.store.items.get(a.sessionId),body=JSON.stringify({csrf:item.csrf,uris:["test-uri"]});
  assert.equal((await s.request(base+"/select",{method:"POST",headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body})).status,403);
  assert.equal((await s.request(base+"/select",{method:"POST",headers:{Origin:env.PUBLIC_BASE_URL,Cookie:cookie,"Content-Type":"application/json"},body})).status,200);
  assert.equal(s.audit.revoked,1);const bytes=item.files[0].bytes;
  const headers={Origin:origin,"X-Kiosk-Secret":a.kioskSecret,"Content-Type":"application/json"};
  assert.equal((await s.request(base+"/files/"+item.files[0].fileId,{headers})).text,"%PDF-");
  assert.equal((await s.request(base+"/complete",{method:"POST",headers,body:'{"result":"cancelled"}'})).status,200);
  assert.ok(bytes.every(b=>b===0));assert.equal(s.app.store.items.size,0);
});
test("hosted consent denial issues no token",async t=>{
  const s=await setup(t,true),a=await s.create(),start=await s.request(new URL(a.qrUrl).pathname);
  const state=new URL(start.headers.location).searchParams.get("state"),cookie=start.headers["set-cookie"][0].split(";")[0];
  assert.equal((await s.request("/digilocker/callback?error=access_denied&state="+state,{headers:{Cookie:cookie}})).status,200);
  assert.equal(s.audit.tokens,0);assert.equal(s.app.store.items.get(a.sessionId).status,"DENIED");
});
test("per-kiosk switch rejects disabled, unknown and forged settings, and takes effect on the next session",async t=>{
  const s=await setup(t,true);
  async function createFor(kioskId){const key=(await s.request("/api/digilocker/bootstrap",{headers:{Origin:origin}})).json().kioskKey;
    return s.request("/api/digilocker/sessions",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","X-Digilocker-Kiosk-Key":key},body:JSON.stringify({kioskId,language:"en",digilocker:true,customerSettings:{digilocker:true}})});
  }
  for(const id of [undefined,"KIOSK-OFF","KIOSK-UNKNOWN","LOCAL-KIOSK"]){const r=await createFor(id);assert.equal(r.status,403);assert.equal(r.json().error,"DIGILOCKER_KIOSK_DISABLED");}
  assert.equal(s.app.store.items.size,0);
  const a=(await createFor("KIOSK-ON")).json();assert.equal(s.app.store.items.get(a.sessionId).kioskId,"KIOSK-ON");
  s.policies.set("KIOSK-ON",false);assert.equal((await createFor("KIOSK-ON")).status,403);
  s.policies.set("KIOSK-OFF",true);assert.equal((await createFor("KIOSK-OFF")).status,201);
  assert.equal(s.audit.tokens,0);
});
test("kiosk policy fails closed on unavailable or mismatched backend configuration",async()=>{
  const config={backend:"http://127.0.0.1:5080"};
  for(const request of [async()=>{throw new Error("offline");},async()=>new Response("bad",{status:500}),async()=>new Response("invalid json")])await assert.rejects(requireKioskEnabled(config,"KIOSK-ON",request),e=>e.code==="DIGILOCKER_KIOSK_UNAVAILABLE");
  for(const kiosk of [null,{kioskId:"OTHER",customerSettings:{digilocker:true}},{kioskId:"KIOSK-ON"},{kioskId:"KIOSK-ON",customerSettings:{digilocker:"true"}}])await assert.rejects(requireKioskEnabled(config,"KIOSK-ON",async()=>new Response(JSON.stringify({kiosk}))),e=>e.code==="DIGILOCKER_KIOSK_DISABLED");
});
