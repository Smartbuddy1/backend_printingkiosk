"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path");
const {spawnSync}=require("node:child_process");
// A copied test can verify the actual immutable release without editing it.
const moduleRoot=process.env.DIGILOCKER_TEST_RELEASE||path.resolve(__dirname,"../..");
const {probePdf,parserPreflight}=require(path.join(moduleRoot,"digilocker-hosted/preflight.cjs"));
const {unlockPdf}=require(path.join(moduleRoot,"digilocker-local/unlock-pdf.cjs"));
const {validateDocument}=require(path.join(moduleRoot,"digilocker-local/documents.cjs"));
const config={pdfUnlock:true,maxBytes:10485760,maxPages:10,frontend:path.join(moduleRoot,"digilocker-hosted")};
const linux={skip:process.platform!=="linux"};
function encrypted(bits,password="fixture-password"){
  const script=`import os,sys,subprocess
a=os.memfd_create('synthetic-input');b=os.memfd_create('synthetic-output')
os.write(a,sys.stdin.buffer.read());os.lseek(a,0,0)
subprocess.run(['/usr/bin/qpdf','--encrypt',sys.argv[2],'fixture-owner',sys.argv[1]]+(['--use-aes=y'] if sys.argv[1]=='128' else [])+['--','/proc/self/fd/'+str(a),'/proc/self/fd/'+str(b)],pass_fds=(a,b),check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
os.lseek(b,0,0);sys.stdout.buffer.write(os.read(b,1000000))`;
  const p=spawnSync("/usr/bin/python3",["-I","-B","-c",script,String(bits),password],{input:probePdf(),maxBuffer:2000000});
  assert.equal(p.status,0,"synthetic encryption must succeed");return p.stdout;
}
for(const bits of [128,256])test(`native ${bits}-bit PDF needs a password, rejects wrong password and produces an independently readable PDF`,linux,async()=>{
  const input=encrypted(bits);
  await assert.rejects(validateDocument(input,"application/pdf",config),{code:"PDF_PASSWORD_REQUIRED"});
  await assert.rejects(unlockPdf(input,"wrong",config),{code:"PDF_PASSWORD_INCORRECT"});
  const opened=await unlockPdf(input,"fixture-password",config);
  assert.equal(opened.pages,1);assert.equal((await validateDocument(opened.bytes,"application/pdf",config)).pages,1);
  opened.bytes.fill(0);input.fill(0);
});
test("native startup checks helper; cancellation, invalid PDFs and page limits fail closed",linux,async()=>{
  await parserPreflight(config);
  await assert.rejects(unlockPdf(encrypted(256),"fixture-password",{...config,maxPages:0}),{code:"PAGE_LIMIT"});
  await assert.rejects(unlockPdf(Buffer.from("%PDF-invalid"),"fixture-password",config));
  const abort=new AbortController();abort.abort();await assert.rejects(unlockPdf(probePdf(),"fixture-password",config,abort.signal),{code:"SESSION_ENDED"});
});
test("encrypted provider bytes require the original HMAC before password entry",linux,async()=>{
  const {Provider}=require(path.join(moduleRoot,"digilocker-local/provider.cjs")),crypto=require("node:crypto");
  const input=encrypted(256),secret="synthetic-provider-secret";
  const provider=new Provider({...config,clientSecret:secret,endpoints:{file:"https://offline.invalid/"}});
  const headers=new Headers({"content-type":"application/pdf",hmac:crypto.createHmac("sha256",secret).update(input).digest("base64")});
  provider.request=async()=>({bytes:Buffer.from(input),headers});
  const file=await provider.download({uri:"sample",name:"Synthetic",mime:"application/pdf"},"offline",undefined,{allowEncrypted:true});
  assert.equal(file.encrypted,true);assert.deepEqual(file.bytes,input);file.bytes.fill(0);
  headers.delete("hmac");await assert.rejects(provider.download({uri:"sample",mime:"application/pdf"},"offline",undefined,{allowEncrypted:true}),{code:"INTEGRITY_FAILED"});
  input.fill(0);
});
for(const kind of ["plain",128,256])test(`${kind} PDF with no opening password bypasses password entry and reaches kiosk handoff`,linux,async t=>{
  const http=require("node:http"),crypto=require("node:crypto");
  const {Provider}=require(path.join(moduleRoot,"digilocker-local/provider.cjs"));
  const {createService}=require(path.join(moduleRoot,"digilocker-local/server.cjs"));
  const {hostedConfig}=require(path.join(moduleRoot,"digilocker-hosted/config.cjs"));
  const cfg=hostedConfig({PUBLIC_BASE_URL:"https://api.example.test",DIGILOCKER_ALLOWED_ORIGINS:"https://kiosk.example.test",DIGILOCKER_ENABLED:"true",DIGILOCKER_CLIENT_ID:"offline-client",DIGILOCKER_CLIENT_SECRET:"offline-secret",DIGILOCKER_REDIRECT_URI:"https://api.example.test/digilocker/callback",DIGILOCKER_KIOSK_BACKEND_URL:"http://127.0.0.1:5080",DIGILOCKER_PDF_UNLOCK:"true"});
  const input=kind==="plain"?probePdf():encrypted(kind,"");
  assert.equal((await validateDocument(input,"application/pdf",cfg)).pages,1);
  const provider=new Provider(cfg);let revoked=0;
  provider.request=async()=>({bytes:Buffer.from(input),headers:new Headers({"content-type":"application/pdf",hmac:crypto.createHmac("sha256",cfg.clientSecret).update(input).digest("base64")})});
  provider.revoke=async()=>{revoked++;};
  const app=createService(cfg,{provider,unlockPdf:async()=>{assert.fail("No opening password must never invoke unlock");}});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));t.after(()=>app.close());
  const {item,kioskSecret}=app.store.create(),paired=app.store.pair(item.pairCode);
  item.token="offline-token";item.documents.set("fixture",{uri:"fixture",mime:"application/pdf",name:"Synthetic document"});app.store.touchPhone(item);
  function request(route,method,headers,body){return new Promise((resolve,reject)=>{
    const req=http.request({hostname:"127.0.0.1",port:app.server.address().port,path:route,method,headers:{Host:"api.example.test",...headers}},res=>{const chunks=[];res.on("data",chunk=>chunks.push(chunk));res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));});req.on("error",reject);req.end(body);
  });}
  const base="/api/digilocker/sessions/"+item.id;
  const result=await request(base+"/select","POST",{Origin:cfg.publicBase,Cookie:`dl_phone=${item.id}.${paired.phone}`,"Content-Type":"application/x-www-form-urlencoded"},new URLSearchParams({csrf:item.csrf,uris:"fixture"}).toString());
  assert.equal(result.status,303);assert.match(result.headers.location,/^\/digilocker\/result/);
  assert.equal(item.status,"READY");assert.equal(item.awaitingPassword,false);assert.equal(revoked,1);assert.equal(item.token,null);
  const file=await request(base+"/files/"+item.files[0].fileId,"GET",{Origin:"https://kiosk.example.test","X-Kiosk-Secret":kioskSecret});
  assert.equal(file.status,200);assert.deepEqual(file.bytes,input);assert.equal((await validateDocument(file.bytes,"application/pdf",cfg)).pages,1);
  const retained=item.files[0].bytes;await app.store.end(item,"CANCELLED");assert.ok(retained.every(v=>v===0));input.fill(0);file.bytes.fill(0);
});
