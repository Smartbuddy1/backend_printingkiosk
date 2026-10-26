"use strict";
// Browser-level mock E2E using the installed Chromium browser and existing ws.
// No browser/dependency download; all page network traffic is restricted to loopback.
const assert=require("node:assert/strict"),fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),{spawn}=require("node:child_process"),WebSocket=require("ws");
const {makeConfig}=require("../config.cjs"),{startStack}=require("../start.cjs");
class CDP{
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.listeners=[];ws.on("message",raw=>{const m=JSON.parse(raw);if(m.id){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}else for(const fn of this.listeners)fn(m);});}
  send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++this.id,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},15000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  async value(session,expression){const result=await this.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true},session);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
  async wait(session,expression,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await this.value(session,expression))return;await new Promise(r=>setTimeout(r,150));}throw new Error(`Browser condition timed out: ${expression}`);}
}
async function run(){
  const browser=[process.env.DIGILOCKER_TEST_BROWSER,"C:/Program Files/Google/Chrome/Application/chrome.exe","C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(p=>p&&fs.existsSync(p));
  if(!browser)throw new Error("No installed Chrome/Edge found; set DIGILOCKER_TEST_BROWSER. No browser will be downloaded.");
  const profile=await fsp.mkdtemp(path.join(os.tmpdir(),"digilocker-browser-")),artifacts=path.join(profile,"artifacts");await fsp.mkdir(artifacts);
  const wifi=process.argv.includes("--wifi");
  const lan=wifi?{DIGILOCKER_LAN_DEMO:"true",DIGILOCKER_LAN_HOST:require("../../tools/digilocker-demo.cjs").networkAddress()}:{};
  const stack=await startStack(makeConfig({DIGILOCKER_ENABLED:"true",DIGILOCKER_PORT:"0",DIGILOCKER_MOCK_PORT:"0",...lan}),{log:event=>console.log("Mock state:",event.state)});
  let child,cdp,lastPhone;const exceptions=[],blocked=[];
  try{
    const endpoint=await new Promise((resolve,reject)=>{
      child=spawn(browser,["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-component-update","--disable-sync","--disable-extensions","--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication",`--user-data-dir=${profile}`,"--remote-debugging-port=0","about:blank"],{windowsHide:true,stdio:["ignore","ignore","pipe"]});
      const timer=setTimeout(()=>reject(new Error("Browser startup timed out")),15000);child.once("error",reject);
      child.stderr.on("data",chunk=>{const match=/DevTools listening on (ws:\/\/[^\s]+)/.exec(String(chunk));if(match){clearTimeout(timer);resolve(match[1]);}});
    });
    const ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});cdp=new CDP(ws);
    cdp.listeners.push(m=>{
      if(m.method==="Runtime.exceptionThrown")exceptions.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
      if(m.method==="Fetch.requestPaused"){
        let allowed=false;try{const u=new URL(m.params.request.url);allowed=["data:","blob:"].includes(u.protocol)||[stack.config.localOrigin,new URL(stack.config.endpoints.token).origin].includes(u.origin);}catch{}
        if(!allowed)blocked.push(new URL(m.params.request.url).origin);
        void cdp.send(allowed?"Fetch.continueRequest":"Fetch.failRequest",{requestId:m.params.requestId,...(allowed?{}:{errorReason:"BlockedByClient"})},m.sessionId).catch(()=>{});
      }
    });
    async function page(width,height){const {targetId}=await cdp.send("Target.createTarget",{url:"about:blank"});const {sessionId}=await cdp.send("Target.attachToTarget",{targetId,flatten:true});await cdp.send("Runtime.enable",{},sessionId);await cdp.send("Page.enable",{},sessionId);await cdp.send("Fetch.enable",{patterns:[{urlPattern:"*"}]},sessionId);await cdp.send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<600},sessionId);return sessionId;}
    async function shot(session,name){const {data}=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false},session);await fsp.writeFile(path.join(artifacts,name),Buffer.from(data,"base64"));}
    const kiosk=await page(wifi?412:1280,wifi?915:960);await cdp.send("Page.navigate",{url:stack.config.localOrigin},kiosk);
    await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-launch:not([disabled])"))');
    await shot(kiosk,"01-services.png");
    await cdp.value(kiosk,'document.querySelector(".dl-launch").click()');
    await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-qr svg"))');
    assert.equal(await cdp.value(kiosk,'document.querySelectorAll(".dl-pair a").length'),0);
    assert.equal(await cdp.value(kiosk,'JSON.parse(sessionStorage.getItem("kioskCustomerState")).documentSource'),"digilocker");
    const oldPair=[...stack.app.store.items.values()].find(s=>s.status==="CREATED"&&s.pairCode).pairCode;
    await cdp.value(kiosk,'document.querySelector("[data-digilocker=refresh]").click()');
    await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-qr svg"))');
    const refreshedPair=[...stack.app.store.items.values()].find(s=>s.status==="CREATED"&&s.pairCode).pairCode;
    assert.notEqual(refreshedPair,oldPair);
    assert.equal((await fetch(stack.config.localOrigin+"/digilocker/start/"+oldPair,{redirect:"manual"})).status,410);
    await cdp.send("Page.reload",{ignoreCache:true},kiosk);
    await new Promise(resolve=>setTimeout(resolve,500));
    await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-qr svg")) && window.DigilockerUI.isActive()');
    assert.equal(await cdp.value(kiosk,'document.querySelectorAll(".qr-only-upload-stage, .dl-pair a").length'),0);
    const reloadedPair=[...stack.app.store.items.values()].find(s=>s.status==="CREATED"&&s.pairCode).pairCode;
    assert.notEqual(reloadedPair,refreshedPair);
    assert.equal((await fetch(stack.config.localOrigin+"/digilocker/start/"+refreshedPair,{redirect:"manual"})).status,410);
    assert.equal(stack.config.pairTtl,180000);
    assert.equal(await cdp.value(kiosk,'document.querySelectorAll("[data-digilocker-countdown]").length'),1);
    assert.equal(await cdp.value(kiosk,'document.querySelectorAll("#customer-idle-notice").length'),0);
    const pairDeadline=await cdp.value(kiosk,'state.customerInactivityDeadline');
    assert.ok(pairDeadline-Date.now()<=180000 && pairDeadline-Date.now()>170000);
    await cdp.value(kiosk,'for(let i=0;i<10;i++){render();noteCustomerActivity();}');
    assert.equal(await cdp.value(kiosk,'state.customerInactivityDeadline'),pairDeadline);
    await cdp.value(kiosk,'window.realPairNow=Date.now;Date.now=()=>realPairNow()+181000');
    await cdp.wait(kiosk,'state.step === 0 && !window.DigilockerUI.isActive()');
    await cdp.value(kiosk,'Date.now=window.realPairNow');
    await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-launch:not([disabled])"))');
    await cdp.value(kiosk,'document.querySelector(".dl-launch").click()');
    await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-qr svg"))');
    const qrUrl=stack.config.localOrigin+"/digilocker/start/"+[...stack.app.store.items.values()].find(s=>s.status==="CREATED"&&s.pairCode).pairCode;
    assert.ok(qrUrl.startsWith(stack.config.localOrigin+"/digilocker/start/"));
    await shot(kiosk,"02-pair.png");
    const phone=await page(412,915);lastPhone=phone;await cdp.send("Page.navigate",{url:qrUrl},phone);
    await cdp.wait(phone,'Boolean(document.querySelector("button[value=allow]"))');
    await cdp.value(phone,'document.querySelector("button[value=allow]").click()');
    await cdp.wait(phone,'document.querySelectorAll("input[type=checkbox]").length === 3');
    assert.equal(await cdp.value(phone,'document.querySelectorAll("input:checked").length'),0);
    await cdp.value(phone,'[...document.querySelectorAll("input[type=checkbox]")].slice(0,2).forEach(x=>x.click())');
    await shot(phone,"03-phone-selection.png");
    await cdp.value(phone,'document.querySelector("button.send").click()');
    await cdp.wait(phone,'Boolean(document.querySelector(".result.ok"))');
    await cdp.wait(kiosk,'document.querySelectorAll(".dl-files li").length === 2');
    assert.equal(stack.mock.audit.revoked,1);await shot(kiosk,"04-documents-ready.png");
    await cdp.value(kiosk,'document.querySelector("[data-digilocker=confirm]").click()');
    await cdp.wait(kiosk,'state.step === 2 && jobFiles().length === 2');
    assert.equal(await cdp.value(kiosk,'effectivePageCount()'),3);
    await cdp.value(kiosk,'state.settings.copies=2;state.settings.colorMode="color";render()');
    const pricing=await cdp.value(kiosk,'priceDetails()');assert.equal(pricing.total,3*2*pricing.rates.color);assert.ok(pricing.total>0);
    assert.equal([...stack.app.store.items.values()][0].status,"READY");
    await cdp.value(kiosk,'goToNextStep()');
    await cdp.wait(kiosk,'state.step === 3 && Boolean(document.querySelector("[data-action=demo-payment-success]"))');
    assert.notEqual(await cdp.value(kiosk,'state.paymentStatus'),"Success");assert.equal([...stack.app.store.items.values()][0].status,"READY");
    await shot(kiosk,"05-existing-payment.png");
    await cdp.value(kiosk,'document.querySelector("[data-action=demo-payment-success]").click()');
    await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-result")) && document.querySelector(".dl-content").textContent.includes("Printing complete")');
    assert.equal(stack.app.store.items.size,0);assert.equal(stack.app.store.reserved,0);
    assert.equal(await cdp.value(kiosk,'jobFiles().some(f=>f.printContentBase64 || f.previewUrl)'),false);
    await shot(kiosk,"06-complete.png");
    await cdp.value(kiosk,'document.querySelector("[data-digilocker=home]").click()');
    await cdp.wait(kiosk,'state.step === 0 && Boolean(document.querySelector(".dl-launch"))');
    // Leaving the existing preview must also clear the feature session and bytes.
    await cdp.value(kiosk,'document.querySelector(".dl-launch").click()');
    await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-qr svg"))');
    const flow=require("./flow.cjs"),pending=[...stack.app.store.items.values()][0];
    const simulatedPhone=await flow.connect(stack,{qrUrl:`${stack.config.localOrigin}/digilocker/start/${pending.pairCode}`});
    await flow.select(stack,{sessionId:pending.id},simulatedPhone);
    await cdp.wait(kiosk,'document.querySelectorAll(".dl-files li").length === 2');
    await cdp.value(kiosk,'document.querySelector("[data-digilocker=confirm]").click()');
    await cdp.wait(kiosk,'state.step === 2 && jobFiles().length === 2');
    const previewDeadline=await cdp.value(kiosk,'state.customerInactivityDeadline');
    await cdp.value(kiosk,'for(let i=0;i<30;i++)render()');
    assert.equal(await cdp.value(kiosk,'state.customerInactivityDeadline'),previewDeadline);
    const timedOutBytes=[...stack.app.store.items.values()][0].files[0].bytes;
    await shot(kiosk,"07-preview-timeout-countdown.png");
    // Fast-forward wall time; let the real one-second browser deadline checker
    // run. A background render must not grant a new two-minute session.
    await cdp.value(kiosk,'window.restoreIdleClock=Date.now;Date.now=()=>window.restoreIdleClock()+121000');
    await cdp.wait(kiosk,'state.step === 0 && !window.DigilockerUI.isActive() && jobFiles().length === 0');
    await cdp.value(kiosk,'Date.now=window.restoreIdleClock');
    await new Promise(r=>setTimeout(r,300));assert.equal(stack.app.store.items.size,0);assert.equal(stack.app.store.reserved,0);
    assert.ok(timedOutBytes.every(b=>b===0));
    for(const language of ["hi","mr"]){
      await cdp.value(kiosk,`state.customerLanguage=${JSON.stringify(language)};render();document.querySelector(".dl-launch").click()`);
      await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-qr svg"))');
      const header=await cdp.value(kiosk,'document.querySelector(".dl-stage h1").textContent');assert.ok(/[\u0900-\u097f]/.test(header));
      await cdp.value(kiosk,'document.querySelector("[data-digilocker=home]").click()');
      await cdp.wait(kiosk,'state.step === 0');
    }
    // Exercise the same reset entry that the existing inactivity timer invokes.
    await cdp.value(kiosk,'state.customerLanguage="en";render();document.querySelector(".dl-launch").click()');
    await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-qr svg"))');
    await cdp.value(kiosk,'resetCustomer();render()');
    await new Promise(r=>setTimeout(r,300));assert.equal(stack.app.store.items.size,0);
    // The phone must clear its document list and revoke access even if nobody
    // touches the kiosk again. Neither periodic status checks nor redraws renew it.
    await cdp.value(kiosk,'document.querySelector(".dl-launch").click()');
    await cdp.wait(kiosk,'Boolean(document.querySelector(".dl-qr svg"))');
    const idlePhoneUrl=stack.config.localOrigin+"/digilocker/start/"+[...stack.app.store.items.values()].find(s=>s.status==="CREATED"&&s.pairCode).pairCode;
    await cdp.send("Page.navigate",{url:idlePhoneUrl},phone);
    await cdp.wait(phone,'Boolean(document.querySelector("button[value=allow]"))');
    await cdp.value(phone,'document.querySelector("button[value=allow]").click()');
    await cdp.wait(phone,'document.querySelectorAll("input[type=checkbox]").length === 3');
    await cdp.value(phone,'window.restoreIdleClock=Date.now;Date.now=()=>window.restoreIdleClock()+121000');
    await cdp.wait(phone,'!document.querySelector("form") && document.querySelector("h1").textContent === "Session ended"');
    await shot(phone,"08-phone-expired.png");
    await cdp.value(phone,'Date.now=window.restoreIdleClock');
    await new Promise(r=>setTimeout(r,300));assert.equal(stack.app.store.items.size,0);assert.equal(stack.mock.tokens.size,0);
    await cdp.value(kiosk,'resetCustomer();render()');
    assert.deepEqual(exceptions,[]);
    console.log("PASS browser E2E: consent, PDF pricing/payment, mock print, deletion, languages, stable preview timeout, phone idle revocation and reset.");
    console.log(`Screenshots: ${artifacts}`);
    if(blocked.length)console.log(`Blocked non-local browser requests: ${blocked.length}`);
  }catch(error){
    console.error("Mock session states:",[...stack.app.store.items.values()].map(s=>({status:s.status,error:s.error})));
    if(cdp&&lastPhone){console.error("Mock phone page:",await cdp.value(lastPhone,'document.body.innerText').catch(()=>"unavailable"));}
    if(exceptions.length)console.error("Browser errors:",exceptions.join("\n"));
    console.error(`Browser artifacts: ${artifacts}`);throw error;
  }finally{
    if(cdp){await cdp.send("Browser.close").catch(()=>{});cdp.ws.close();}
    if(child && child.exitCode===null)child.kill();
    await stack.close();
    // Keep the unique test profile/artifact folder for review; no recursive deletion.
  }
}
if(require.main===module)run().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={run};
