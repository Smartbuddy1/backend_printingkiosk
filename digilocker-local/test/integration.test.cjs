"use strict";
const test=require("node:test"),assert=require("node:assert/strict");const {makeConfig}=require("../config.cjs"),{startStack}=require("../start.cjs");const flow=require("./flow.cjs");
async function setup(t,options={}){const config=makeConfig({DIGILOCKER_ENABLED:"true",DIGILOCKER_PORT:"0",DIGILOCKER_MOCK_PORT:"0"});const stack=await startStack(config,options);t.after(()=>stack.close());return stack;}

test("phone inactivity: polling cannot renew access; authenticated activity extends it; expiry revokes the token",async t=>{
  let now=Date.now();const stack=await setup(t,{now:()=>now});
  const session=await flow.create(stack),phone=await flow.connect(stack,session);
  const base=`${stack.config.localOrigin}/api/digilocker/sessions/${session.sessionId}`;
  const headers={Cookie:phone.cookie,Origin:stack.config.localOrigin,"Content-Type":"application/json"};
  const item=stack.app.store.items.get(session.sessionId),initial=item.phoneIdleExpiresAt;
  now+=119000;
  assert.equal((await fetch(base+"/phone-status",{headers})).status,200);
  assert.equal(item.phoneIdleExpiresAt,initial);
  assert.equal((await fetch(base+"/phone-activity",{method:"POST",headers,body:JSON.stringify({csrf:"wrong"})})).status,403);
  assert.equal(item.phoneIdleExpiresAt,initial);
  assert.equal((await fetch(base+"/phone-activity",{method:"POST",headers,body:JSON.stringify({csrf:phone.csrf})})).status,200);
  assert.equal(item.phoneIdleExpiresAt,now+120000);
  now+=120001;
  assert.equal((await fetch(base+"/phone-status",{headers})).status,410);
  assert.equal(stack.app.store.items.size,0);assert.equal(stack.mock.audit.revoked,1);assert.equal(stack.mock.tokens.size,0);
  assert.equal((await flow.select(stack,session,phone)).status,410);
});
test("full HTTP mock: pair -> PKCE consent -> list -> verified downloads -> print handoff -> deletion",async t=>{
  const stack=await setup(t);const session=await flow.create(stack,"mr");assert.equal((await flow.status(stack,session)).status,"CREATED");
  assert.ok(!session.qrUrl.includes(session.kioskSecret));assert.match(session.qrSvg,/<svg/);assert.match(session.qrSvg,/width="320"/);
  const phone=await flow.connect(stack,session);assert.match(phone.setCookie,/HttpOnly/);assert.match(phone.setCookie,/SameSite=Lax/);assert.equal(phone.uris.length,3);
  assert.ok(!phone.html.includes(session.kioskSecret));assert.ok(!phone.html.includes("access_token"));assert.ok(!/ checked(?:\s|>)/.test(phone.html));
  assert.equal((await flow.status(stack,session)).status,"PHONE_CONNECTED");
  const base=`${stack.config.localOrigin}/api/digilocker/sessions/${session.sessionId}`;
  assert.equal((await fetch(base+"/status",{headers:{Cookie:phone.cookie}})).status,401);
  assert.equal((await fetch(base+"/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"result":"done"}'})).status,401);
  assert.equal((await fetch(phone.callback,{headers:{Cookie:phone.cookie}})).status,400);
  assert.equal((await fetch(session.qrUrl,{redirect:"manual"})).status,410);
  assert.equal((await flow.select(stack,session,phone)).status,200);
  const ready=await flow.status(stack,session);assert.equal(ready.status,"READY");assert.deepEqual(ready.files.map(f=>f.pages),[2,1]);
  assert.equal(stack.mock.audit.revoked,1);assert.equal(stack.mock.tokens.size,0);assert.equal(stack.app.store.items.get(session.sessionId).token,null);
  const bytes=stack.app.store.items.get(session.sessionId).files[0].bytes;
  assert.equal((await fetch(base+"/files/"+ready.files[0].fileId)).status,401);
  const file=await fetch(base+"/files/"+ready.files[0].fileId,{headers:flow.kioskHeaders(session)});assert.equal(file.status,200);assert.equal((await file.text()).slice(0,5),"%PDF-");assert.equal(file.headers.get("cache-control"),"no-store");
  assert.equal((await flow.complete(stack,session)).status,409);
  assert.equal((await fetch(base+"/printing",{method:"POST",headers:flow.kioskHeaders(session)})).status,200);
  assert.equal((await flow.complete(stack,session)).status,200);
  assert.equal(stack.app.store.items.size,0);assert.equal(stack.app.store.reserved,0);assert.ok(bytes.every(b=>b===0));
  assert.equal((await fetch(base+"/files/"+ready.files[0].fileId,{headers:flow.kioskHeaders(session)})).status,410);
});
test("phone requests enforce cookie, CSRF, origin, session ownership and document allowlist",async t=>{
  const stack=await setup(t),a=await flow.create(stack),b=await flow.create(stack),phone=await flow.connect(stack,a);
  assert.equal((await flow.select(stack,a,{...phone,cookie:""})).status,401);
  assert.equal((await flow.select(stack,a,{...phone,csrf:"wrong"})).status,403);
  assert.equal((await flow.select(stack,b,phone)).status,403);
  assert.equal((await flow.select(stack,a,phone,["unlisted-private-uri"])).status,400);
  assert.equal((await flow.select(stack,a,phone,[phone.uris[0],phone.uris[0]])).status,400);
  assert.equal((await flow.select(stack,a,phone,Array(6).fill(phone.uris[0]))).status,400);
  const noOrigin=await fetch(`${stack.config.localOrigin}/api/digilocker/sessions/${a.sessionId}/select`,{method:"POST",headers:{Cookie:phone.cookie,"Content-Type":"application/json"},body:JSON.stringify({csrf:phone.csrf,uris:phone.uris})});assert.equal(noOrigin.status,403);
  assert.equal(stack.mock.audit.downloads,0);
  assert.equal((await fetch(`${stack.config.localOrigin}/api/digilocker/sessions/${b.sessionId}/status`,{headers:flow.kioskHeaders(a)})).status,401);
  await flow.complete(stack,a,"cancelled");assert.equal(stack.mock.audit.revoked,1);
});
test("denied consent reaches DENIED without token issuance",async t=>{
  const stack=await setup(t),session=await flow.create(stack);await flow.connect(stack,session,"deny");
  assert.equal((await flow.status(stack,session)).status,"DENIED");assert.equal(stack.mock.audit.tokensIssued,0);assert.equal(stack.app.store.items.get(session.sessionId).phoneHash,null);
});

test("malformed callback consumes state and clears the paired session",async t=>{
  const stack=await setup(t),session=await flow.create(stack);
  const start=await fetch(session.qrUrl,{redirect:"manual"});
  const state=new URL(start.headers.get("location")).searchParams.get("state");
  const response=await fetch(`${stack.config.localOrigin}/digilocker/callback?state=${state}`,{headers:{Cookie:start.headers.get("set-cookie").split(";")[0]}});
  assert.equal(response.status,400);assert.equal((await flow.status(stack,session)).status,"FAILED");
  assert.equal(stack.app.store.states.size,0);assert.equal(stack.app.store.items.get(session.sessionId).phoneHash,null);
  assert.equal(stack.mock.audit.tokensIssued,0);
});

test("revocation failure prevents READY and erases all downloaded bytes",async t=>{
  const stack=await setup(t),session=await flow.create(stack),phone=await flow.connect(stack,session);
  stack.app.store.revoke=async()=>{throw new (require("../security.cjs").Failure)("REVOKE_FAILED",502);};
  assert.equal((await flow.select(stack,session,phone)).status,502);
  const item=stack.app.store.items.get(session.sessionId);
  assert.equal(item.status,"FAILED");assert.equal(item.token,null);assert.equal(item.files.length+item.pending.length,0);assert.equal(stack.app.store.reserved,0);
});
test("missing HMAC fails closed, deletes bytes and revokes the token",async t=>{
  const stack=await setup(t,{mock:{fault:response=>{response.hmac=null;}}}),session=await flow.create(stack),phone=await flow.connect(stack,session);
  const response=await flow.select(stack,session,phone);assert.equal(response.status,502);assert.equal((await response.json()).error,"INTEGRITY_FAILED");
  assert.equal((await flow.status(stack,session)).status,"FAILED");assert.equal(stack.mock.audit.revoked,1);assert.equal(stack.app.store.reserved,0);
  assert.equal(stack.app.store.items.get(session.sessionId).files.length,0);
});
test("cancellation during download cannot resurrect READY and revokes the token",async t=>{
  let release,entered;const wait=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
  const stack=await setup(t,{mock:{fault:async()=>{entered();await wait;}}}),session=await flow.create(stack),phone=await flow.connect(stack,session);
  const downloading=flow.select(stack,session,phone);await seen;await flow.complete(stack,session,"cancelled");release();await downloading;
  assert.equal(stack.app.store.items.size,0);assert.equal(stack.app.store.reserved,0);assert.equal(stack.mock.tokens.size,0);
});
test("disabled feature has no DigiLocker routes or injected UI",async t=>{
  const stack=await startStack(makeConfig({DIGILOCKER_PORT:"0"}));t.after(()=>stack.close());
  for(const route of ["/api/digilocker/sessions","/digilocker/runtime.js","/digilocker/documents"]){const response=await fetch(stack.config.localOrigin+route);assert.equal(response.status,404);}
  const html=await (await fetch(stack.config.localOrigin)).text();assert.ok(!html.includes("/digilocker/kiosk.js"));
  const app=await (await fetch(stack.config.localOrigin+"/app.js")).text();assert.ok(!app.includes("digilockerOriginalStartLocalPrintJob"));
});
test("local bootstrap and session creation reject external origins and tunnel hosts",async t=>{
  const stack=await setup(t);
  assert.equal((await fetch(stack.config.localOrigin+"/digilocker/runtime.js",{headers:{Origin:"https://other.example"}})).status,403);
  assert.equal((await fetch(stack.config.localOrigin+"/digilocker/runtime.js",{headers:{"x-forwarded-host":"public-tunnel.example"}})).status,403);
  assert.equal((await fetch(stack.config.localOrigin+"/api/digilocker/sessions",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,401);
  assert.equal((await fetch(stack.config.localOrigin+"/.env")).status,404);
  assert.equal((await fetch(stack.config.localOrigin+"/assets/../../.env")).status,404);
});
test("mock token endpoint verifies PKCE, redirect, client auth and one-use code",async t=>{
  const stack=await setup(t),session=await flow.create(stack);
  const start=await fetch(session.qrUrl,{redirect:"manual"}),authorizeUrl=start.headers.get("location"),provider=new URL(authorizeUrl).origin;
  const page=await(await fetch(authorizeUrl)).text();const consent=await fetch(provider+"/mock/consent",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({request:flow.hidden(page,"request"),csrf:flow.hidden(page,"csrf"),decision:"allow"}),redirect:"manual"});
  const code=new URL(consent.headers.get("location")).searchParams.get("code");
  const body={grant_type:"authorization_code",code,redirect_uri:stack.config.redirectUri,client_id:stack.config.clientId,client_secret:stack.config.clientSecret,code_verifier:"A".repeat(43)};
  const invalid=await fetch(stack.config.endpoints.token,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body)});assert.equal(invalid.status,400);assert.equal(stack.mock.audit.tokensIssued,0);
  body.code_verifier=stack.app.store.items.get(session.sessionId).verifier;
  const replay=await fetch(stack.config.endpoints.token,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body)});assert.equal(replay.status,400);
});
