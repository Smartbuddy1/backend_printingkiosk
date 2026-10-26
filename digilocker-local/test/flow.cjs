"use strict";
const assert=require("node:assert/strict");
async function create(stack,language="en") {
  const response=await fetch(stack.config.localOrigin+"/api/digilocker/sessions",{method:"POST",headers:{"Content-Type":"application/json","x-digilocker-kiosk-key":stack.app.kioskKey,Origin:stack.config.localOrigin},body:JSON.stringify({language})});
  assert.equal(response.status,201);return response.json();
}
function kioskHeaders(session) { return {"x-kiosk-secret":session.kioskSecret}; }
function hidden(html,name) { const expression=new RegExp(`name="${name}" value="([^"]+)"`);return expression.exec(html)?.[1]; }
async function connect(stack,session,decision="allow") {
  const start=await fetch(session.qrUrl,{redirect:"manual"});assert.equal(start.status,302);
  const setCookie=start.headers.get("set-cookie"),cookie=setCookie.split(";")[0];
  const authorizeUrl=start.headers.get("location");const authorize=await fetch(authorizeUrl,{redirect:"manual"});assert.equal(authorize.status,200);
  const consent=await authorize.text(),providerOrigin=new URL(authorizeUrl).origin;
  const consentPath = /<form[^>]+action="([^"]+)"/.exec(consent)?.[1];
  assert.ok(consentPath);
  const result=await fetch(new URL(consentPath,providerOrigin),{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Origin:providerOrigin},body:new URLSearchParams({request:hidden(consent,"request"),csrf:hidden(consent,"csrf"),decision}),redirect:"manual"});
  assert.equal(result.status,303);const callback=result.headers.get("location");
  const response=await fetch(callback,{headers:{Cookie:cookie},redirect:"manual"});
  if(decision==="deny"){assert.equal(response.status,200);return {cookie,callback,setCookie};}
  assert.equal(response.status,303);
  const page=await fetch(stack.config.localOrigin+"/digilocker/documents",{headers:{Cookie:cookie}});assert.equal(page.status,200);const html=await page.text();
  const uris=[...html.matchAll(/name="uris" value="([^"]+)"/g)].map(m=>m[1]);
  return {cookie,callback,csrf:hidden(html,"csrf"),uris,html,setCookie};
}
async function select(stack,session,phone,uris=phone.uris.slice(0,2)) {
  return fetch(`${stack.config.localOrigin}/api/digilocker/sessions/${session.sessionId}/select`,{method:"POST",headers:{"Content-Type":"application/json",Origin:stack.config.publicBase,Cookie:phone.cookie},body:JSON.stringify({csrf:phone.csrf,uris})});
}
async function status(stack,session) { return (await fetch(`${stack.config.localOrigin}/api/digilocker/sessions/${session.sessionId}/status`,{headers:kioskHeaders(session)})).json(); }
async function complete(stack,session,result="done") { return fetch(`${stack.config.localOrigin}/api/digilocker/sessions/${session.sessionId}/complete`,{method:"POST",headers:{...kioskHeaders(session),"Content-Type":"application/json"},body:JSON.stringify({result})}); }
module.exports={create,connect,select,status,complete,kioskHeaders,hidden};
