"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http");
const {hostedConfig}=require("../config.cjs");
const {createService}=require("../../digilocker-local/server.cjs");
const {Provider}=require("../../digilocker-local/provider.cjs");
const env={PUBLIC_BASE_URL:"https://api.example.test",DIGILOCKER_ALLOWED_ORIGINS:"https://kiosk.example.test",DIGILOCKER_PORT:"0"};
const origin="https://kiosk.example.test";
async function setup(t,enabled=false){
  const config=hostedConfig({...env,...(enabled?{DIGILOCKER_ENABLED:"true",DIGILOCKER_CLIENT_ID:"offline-test",DIGILOCKER_CLIENT_SECRET:"offline-test",DIGILOCKER_REDIRECT_URI:env.PUBLIC_BASE_URL+"/digilocker/callback"}:{})});
  const audit={tokens:0,revoked:0};
  const provider={authorize:p=>new Provider(config).authorize(p),token:async()=>{audit.tokens++;return {accessToken:"offline-token",scope:"openid"};},list:async()=>new Map([["test-uri",{uri:"test-uri",name:"Test",mime:"application/pdf"}]]),download:async()=>({name:"Test",mime:"application/pdf",pages:1,size:5,bytes:Buffer.from("%PDF-")}),revoke:async()=>{audit.revoked++;}};
  const app=createService(config,{provider});
  await new Promise(r=>app.server.listen(0,"127.0.0.1",r));t.after(()=>app.close());
  function request(path,{method="GET",headers={},body}={}){return new Promise((resolve,reject)=>{
    const req=http.request({hostname:"127.0.0.1",port:app.server.address().port,path,method,headers:{Host:"api.example.test",...headers}},res=>{const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)});});});req.on("error",reject);req.end(body);
  });}
  async function create(){const bootstrap=await request("/api/digilocker/bootstrap",{headers:{Origin:origin}});assert.equal(bootstrap.status,200);const key=bootstrap.json().kioskKey;const headers={Origin:origin,"Content-Type":"application/json","X-Digilocker-Kiosk-Key":key};const result=await request("/api/digilocker/sessions",{method:"POST",headers,body:'{"language":"en"}'});assert.equal(result.status,201);return {...result.json(),createHeaders:headers};}
  return {app,audit,request,create,config};
}
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
