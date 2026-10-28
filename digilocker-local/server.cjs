"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const QRCode = require("qrcode");
const { Sessions } = require("./sessions.cjs");
const { Provider } = require("./provider.cjs");
const { Failure, random, hash, equalHash, readBody, cookies, RateLimiter } = require("./security.cjs");
const { dictionaries } = require("./i18n.cjs");
const phone = require("./phone-pages.cjs");
const { appOverlay, htmlOverlay } = require("./integration/overlay.cjs");
const { localHost } = require("./config.cjs");
const TYPES = { ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".gif":"image/gif", ".svg":"image/svg+xml", ".ico":"image/x-icon", ".woff":"font/woff", ".woff2":"font/woff2", ".ttf":"font/ttf", ".pdf":"application/pdf" };
const PHONE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
function createService(config, options = {}) {
  const provider = options.provider || new Provider(config);
  const store = new Sessions(config, { now: options.now, revoke: token => provider.revoke(token), log: options.log });
  const limiter = new RateLimiter(options.now), kioskKey = random(), kioskKeyHash = hash(kioskKey);
  const source = config.hosted ? "" : fs.readFileSync(path.join(config.frontend,"app.js"),"utf8");
  const kioskSource = config.enabled && !config.hosted ? appOverlay(source,config) : source;
  const sourceHtml = config.hosted ? "" : fs.readFileSync(path.join(config.frontend,"index.html"),"utf8");
  const kioskHtml = config.enabled && !config.hosted ? htmlOverlay(sourceHtml) : sourceHtml;
  const frontendReal = config.hosted ? "" : fs.realpathSync(config.frontend);
  const bootstraps = new Map();
  function send(res,status,type,value,headers={}) {
    res.writeHead(status,{"Content-Type":type,"Cache-Control":"no-store",...headers}); res.end(value);
  }
  const json = (res,status,value) => send(res,status,"application/json; charset=utf-8",JSON.stringify(value));
  const html = (res,status,value) => send(res,status,"text/html; charset=utf-8",value);
  const redirect = (res,location) => send(res,303,"text/plain","",{Location:location});
  const isKiosk = req => {
    const address = req.socket.remoteAddress || "";
    const host = new URL(`http://${req.headers.host || "invalid"}`).hostname;
    if (req.headers["x-forwarded-host"] || req.headers["forwarded"]) return false;
    if (config.lanDemo) return req.headers.host === new URL(config.localOrigin).host;
    return ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(address) && localHost(host);
  };
  function kioskOrigin(req) {
    if (config.hosted) {
      if (!config.allowedOrigins.includes(req.headers.origin)) throw new Failure("NOT_AUTHORIZED",403);
      return;
    }
    if (!isKiosk(req)) throw new Failure("NOT_AUTHORIZED",403);
    if (req.headers.origin && req.headers.origin !== config.localOrigin) throw new Failure("NOT_AUTHORIZED",403);
  }
  function phoneSession(req) {
    const [id,secret] = String(cookies(req).dl_phone || "").split(".");
    if (!id || !secret) throw new Failure("NOT_AUTHORIZED",401);
    return store.phone(id,secret);
  }
  function cookie(value,maxAge) { return `dl_phone=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.publicBase.startsWith("https:") ? "; Secure" : ""}`; }
  function callbackInfo(res, status = 200) {
    return html(res,status,`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Printing Kiosk | DigiLocker callback</title></head><body><main><h1>Printing Kiosk</h1><h2>DigiLocker callback endpoint</h2><p>${config.enabled ? "Start DigiLocker from the Printing Kiosk screen. This address receives the authorization response after your consent." : "This callback address is deployed. DigiLocker access is awaiting approved credentials and activation. No documents can be accessed yet."}</p><p>Opening this address alone does not authenticate a user or confirm DigiLocker approval.</p></main></body></html>`);
  }
  function peer(req) {
    const address = req.socket.remoteAddress || "unknown";
    if (config.hosted && ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(address) && require("node:net").isIP(req.headers["x-real-ip"] || "")) return req.headers["x-real-ip"];
    return address;
  }
  async function select(session,body) {
    if (!equalHash(body.csrf,hash(session.csrf || ""))) throw new Failure("NOT_AUTHORIZED",403);
    if (session.status !== "PHONE_CONNECTED" || !session.token) throw new Failure("STATE_INVALID",409);
    if (!Array.isArray(body.uris) || !body.uris.length || body.uris.length > config.maxFiles || new Set(body.uris).size !== body.uris.length || body.uris.some(uri => typeof uri !== "string" || !session.documents.has(uri))) throw new Failure("SELECTION_INVALID",400);
    store.transition(session,"DOWNLOADING");
    try {
      store.reserve(session,body.uris.length * config.maxBytes);
      for (const uri of body.uris) {
        store.alive(session);
        const file=await provider.download(session.documents.get(uri),session.token,session.abort.signal);
        try { store.alive(session); } catch(error) { file.bytes.fill(0); throw error; }
        session.pending.push({...file,fileId:random(16)});
      }
      await store.revokeToken(session); store.alive(session);
      session.files=session.pending; session.pending=[]; session.documents.clear(); session.verifier=null;
      const size=session.files.reduce((sum,f)=>sum+f.size,0); store.reserved-=session.reserved-size; session.reserved=size;
      store.transition(session,"READY");
    } catch(error) {
      await store.end(session,"FAILED",{code:error instanceof Failure ? error.code : "PROVIDER_UNAVAILABLE"}); throw error;
    }
  }
  async function proxyBackend(req,res,url) {
    // Only explicitly configured loopback services; no inherited URLs or credentials.
    const data = ["POST","PUT","PATCH","DELETE"].includes(req.method) ? await readBody(req,1024*1024) : null;
    const headers={}; for(const name of ["content-type","authorization"])if(req.headers[name])headers[name]=req.headers[name];
    const response=await fetch(config.backend+url.pathname+url.search,{method:req.method,headers,body:data?JSON.stringify(data):undefined,redirect:"error",signal:AbortSignal.timeout(15000)});
    const {boundedBytes}=require("./provider.cjs");const bytes=await boundedBytes(response,2*1024*1024);
    send(res,response.status,response.headers.get("content-type")||"application/json",bytes);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","no-referrer");res.setHeader("X-Frame-Options","DENY");
    res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");res.setHeader("Content-Security-Policy",PHONE_CSP);
    let url,session;
    try {
      url=new URL(req.url,"http://localhost");
      if(req.url.length>4096)throw new Failure("REQUEST_INVALID");
      if (config.hosted) {
        if (req.headers.host !== new URL(config.publicBase).host) throw new Failure("NOT_AUTHORIZED",403);
        if (!(url.pathname.startsWith("/digilocker/") || url.pathname.startsWith("/api/digilocker/"))) throw new Failure("NOT_FOUND",404);
        if (url.pathname.startsWith("/api/digilocker/")) {
          if(req.headers.origin && !config.allowedOrigins.includes(req.headers.origin))throw new Failure("NOT_AUTHORIZED",403);
          if(req.headers.origin)res.setHeader("Access-Control-Allow-Origin",req.headers.origin);
          res.setHeader("Vary","Origin");
          res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
          res.setHeader("Access-Control-Allow-Headers","Content-Type,X-Kiosk-Secret,X-Digilocker-Kiosk-Key");
          if (req.method === "OPTIONS") {kioskOrigin(req);return send(res,204,"text/plain","");}
        }
        if (req.method === "GET" && url.pathname === "/digilocker/health") return json(res,200,{service:"printing-kiosk-digilocker",mode:"live",ready:config.enabled,callback:config.redirectUri});
        if (req.method === "GET" && url.pathname === "/digilocker/callback" && !url.search) return callbackInfo(res);
        if (!config.enabled) {
          if (url.pathname === "/digilocker/callback") return callbackInfo(res,503);
          return json(res,503,{error:"DIGILOCKER_NOT_READY"});
        }
        if (req.method === "GET" && url.pathname === "/api/digilocker/bootstrap") {
          kioskOrigin(req);
          limiter.take("bootstrap:"+peer(req),20);
          for (const [key,entry] of bootstraps) if (entry.expires <= Date.now()) bootstraps.delete(key);
          if (bootstraps.size >= config.maxSessions * 3) throw new Failure("BUSY",503);
          const key=random();bootstraps.set(hash(key).toString("hex"),{origin:req.headers.origin,expires:Date.now()+60000});
          return json(res,200,{kioskKey:key});
        }
      }
      if(config.lanDemo){
        kioskOrigin(req);
        if(req.method === "GET" && url.pathname === "/__demo-status") return json(res,200,{version:options.version,mode:"mock",documents:"samples only",payments:"simulated",printing:"simulated"});
        if(url.pathname.startsWith("/__mock-provider/")){
          const mockPath=url.pathname.slice("/__mock-provider".length);
          if(!((req.method==="GET" && mockPath==="/public/oauth2/1/authorize") || (req.method==="POST" && mockPath==="/mock/consent"))) throw new Failure("NOT_FOUND",404);
          if(req.method==="POST" && req.headers.origin!==config.publicBase)throw new Failure("NOT_AUTHORIZED",403);
          const body=req.method==="POST" ? await readBody(req) : null;
          const target=new URL(mockPath+url.search,new URL(config.endpoints.token).origin);
          const response=await fetch(target,{method:req.method,redirect:"manual",signal:AbortSignal.timeout(5000),headers:body?{"Content-Type":"application/x-www-form-urlencoded"}:{},body:body?new URLSearchParams(body):undefined});
          res.setHeader("Referrer-Policy","strict-origin");
          const headers={};
          for(const name of ["location","content-security-policy"])if(response.headers.has(name))headers[name]=response.headers.get(name);
          const {boundedBytes}=require("./provider.cjs");
          return send(res,response.status,response.headers.get("content-type")||"text/plain",await boundedBytes(response,128*1024),headers);
        }
      }
      if(url.pathname.startsWith("/api/digilocker/") || url.pathname.startsWith("/digilocker/")) {
        if(!config.enabled)throw new Failure("NOT_FOUND",404);
        await store.sweep();
        limiter.take(peer(req),600);
        if(req.method==="GET" && ["/digilocker/phone.css","/digilocker/phone.js"].includes(url.pathname)){
          const filename=url.pathname.endsWith("css")?"phone.css":"phone.js";
          return send(res,200,TYPES[path.extname(filename)]+"; charset=utf-8",fs.readFileSync(path.join(__dirname,"public",filename)));
        }
        if(req.method==="GET" && ["/digilocker/runtime.js","/digilocker/kiosk.js","/digilocker/kiosk.css"].includes(url.pathname)){
          if(config.hosted)throw new Failure("NOT_FOUND",404);
          kioskOrigin(req);
          if(url.pathname.endsWith("runtime.js"))return send(res,200,"text/javascript; charset=utf-8",`window.DigiLockerConfig=${JSON.stringify({enabled:true,preview:config.preview,kioskKey,translations:dictionaries,maxFiles:config.maxFiles})};`);
          const filename=url.pathname.endsWith("css")?"kiosk.css":"kiosk.js";
          return send(res,200,TYPES[path.extname(filename)]+"; charset=utf-8",fs.readFileSync(path.join(__dirname,"public",filename)));
        }
        if(req.method==="POST" && url.pathname==="/api/digilocker/sessions"){
          kioskOrigin(req);
          if(config.hosted){
            const key=hash(String(req.headers["x-digilocker-kiosk-key"]||"")).toString("hex"),entry=bootstraps.get(key);
            if(!entry || entry.expires<=Date.now() || entry.origin!==req.headers.origin)throw new Failure("NOT_AUTHORIZED",401);
            bootstraps.delete(key);
          } else if(!equalHash(req.headers["x-digilocker-kiosk-key"],kioskKeyHash))throw new Failure("NOT_AUTHORIZED",401);
          limiter.take("create:"+peer(req),12);
          const body=await readBody(req); const created=store.create(body.language);session=created.item;
          const qrUrl=`${config.publicBase}/digilocker/start/${session.pairCode}`;
          const qrSvg=await QRCode.toString(qrUrl,{type:"svg",width:320,errorCorrectionLevel:"M",margin:4});
          return json(res,201,{sessionId:session.id,kioskSecret:created.kioskSecret,pairCode:session.pairCode,expiresAt:session.expiresAt,pairExpiresAt:session.pairExpiresAt,qrUrl,qrSvg});
        }
        const start=/^\/digilocker\/start\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if(req.method==="GET" && start){
          limiter.take("phone:"+peer(req),30);
          const paired=store.pair(start[1]);session=paired.session;
          res.setHeader("Set-Cookie",cookie(`${session.id}.${paired.phone}`,Math.ceil(config.sessionTtl/1000)));
          const authorization=new URL(provider.authorize(paired));
          if(config.mode==="mock")authorization.searchParams.set("language",session.language);
          res.writeHead(302,{Location:authorization.href,"Cache-Control":"no-store"});return res.end();
        }
        if(req.method==="GET" && url.pathname==="/digilocker/callback"){
          limiter.take("callback:"+peer(req),30);
          session=store.consumeState(url.searchParams.get("state"),cookies(req).dl_phone);
          if(url.searchParams.has("error")){
            const denied=url.searchParams.get("error")==="access_denied";await store.end(session,denied?"DENIED":"FAILED");res.setHeader("Set-Cookie",cookie("",0));
            return html(res,200,phone.result(session.language,config,false,denied?"denied":"generic"));
          }
          try{
            const code=url.searchParams.get("code");if(!code || code.length>4096)throw new Failure("STATE_INVALID");
            // Finish an in-flight token response even on kiosk cancellation so it can be revoked.
            const grant=await provider.token(code,session.verifier);session.token=grant.accessToken;session.verifier=null;store.alive(session);
            session.documents=await provider.list(session.token,grant.scope,session.abort.signal);store.alive(session);
            if(!session.documents.size){await store.end(session,"FAILED",{code:"noDocuments"});return html(res,400,phone.result(session.language,config,false,"noDocuments"));}
            return redirect(res,"/digilocker/documents");
          }catch(error){await store.end(session,"FAILED",{code:error.code||"PROVIDER_UNAVAILABLE"});throw error;}
        }
        if(req.method==="GET" && url.pathname==="/digilocker/documents"){
          session=phoneSession(req);if(session.status!=="PHONE_CONNECTED" || !session.token)throw new Failure("SESSION_ENDED",410);
          // HTML form navigation needs an Origin header for the CSRF origin check.
          // no-referrer makes Chromium send Origin: null on this POST.
          res.setHeader("Referrer-Policy","strict-origin");
          store.touchPhone(session);
          return html(res,200,phone.documents(session,config));
        }
        if(req.method==="GET" && url.pathname==="/digilocker/result")return html(res,200,phone.result(url.searchParams.get("lang")||"en",config));
        const route=/^\/api\/digilocker\/sessions\/([A-Za-z0-9_-]+)\/(status|select|phone-status|phone-activity|phone-expire|printing|complete|files\/([A-Za-z0-9_-]+))$/.exec(url.pathname);
        if(route){
          const id=route[1],action=route[2];
          if(action.startsWith("phone-")){
            session=phoneSession(req);if(session.id!==id || session.status!=="PHONE_CONNECTED")throw new Failure("NOT_AUTHORIZED",403);
            if(action==="phone-status" && req.method==="GET")return json(res,200,{expiresAt:session.expiresAt,idleExpiresAt:session.phoneIdleExpiresAt});
            if(req.method!=="POST" || req.headers.origin!==config.publicBase)throw new Failure("NOT_AUTHORIZED",403);
            const body=await readBody(req);
            if(!equalHash(body.csrf,hash(session.csrf||"")))throw new Failure("NOT_AUTHORIZED",403);
            if(action==="phone-expire"){
              await store.end(session,"EXPIRED",{remove:true});res.setHeader("Set-Cookie",cookie("",0));
              return json(res,200,{status:"EXPIRED"});
            }
            if(action==="phone-activity"){
              limiter.take("activity:"+session.id,30);store.touchPhone(session);
              return json(res,200,{expiresAt:session.expiresAt,idleExpiresAt:session.phoneIdleExpiresAt});
            }
            throw new Failure("NOT_FOUND",404);
          }
          if(action==="select" && req.method==="POST"){
            if(req.headers.origin!==config.publicBase)throw new Failure("NOT_AUTHORIZED",403);
            session=phoneSession(req);if(session.id!==id)throw new Failure("NOT_AUTHORIZED",403);
            limiter.take("select:"+session.id,10);
            const body=await readBody(req);await select(session,body);
            res.setHeader("Set-Cookie",cookie("",0));session.phoneHash=null;session.csrf=null;
            if((req.headers["content-type"]||"").startsWith("application/json"))return json(res,200,{status:"READY"});
            return redirect(res,`/digilocker/result?lang=${session.language}`);
          }
          kioskOrigin(req);session=store.kiosk(id,req.headers["x-kiosk-secret"]);
          if(action==="status" && req.method==="GET")return json(res,200,{status:session.status,expiresAt:session.expiresAt,phoneActivityAt:session.phoneActivityAt||0,error:session.error,files:session.status==="READY"?session.files.map(({bytes,...meta})=>meta):[]});
          if(action.startsWith("files/") && req.method==="GET"){
            if(!["READY","PRINTING"].includes(session.status))throw new Failure("STATE_INVALID",409);
            const file=session.files.find(f=>f.fileId===route[3]);if(!file?.bytes)throw new Failure("NOT_FOUND",404);
            return send(res,200,file.mime,file.bytes,{"Content-Disposition":`attachment; filename="Document.${file.mime==="application/pdf"?"pdf":file.mime==="image/png"?"png":"jpg"}"`});
          }
          if(action==="printing" && req.method==="POST"){
            store.transition(session,"PRINTING");return json(res,200,{status:"PRINTING"});
          }
          if(action==="complete" && req.method==="POST"){
            const body=await readBody(req),next=({done:"DONE",failed:"FAILED",cancelled:"CANCELLED"})[body.result];
            if(!next || (next==="DONE" && session.status!=="PRINTING"))throw new Failure("STATE_INVALID",409);
            await store.end(session,next,{remove:true});return json(res,200,{status:next});
          }
        }
        throw new Failure("NOT_FOUND",404);
      }
      // The local kiosk shell is never exposed on the phone/tunnel host.
      if(config.hosted)throw new Failure("NOT_FOUND",404);
      kioskOrigin(req);
      res.setHeader("Content-Security-Policy",`default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' ${config.preview?"":config.agent}; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`);
      if(req.method==="GET" && ["/","/index.html"].includes(url.pathname))return html(res,200,config.lanDemo?kioskHtml.replace('<body>', '<body><div role="status" style="position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff3c4;color:#473900;text-align:center;font:13px sans-serif;padding:6px;pointer-events:none">Wi-Fi demo '+String(options.version||'')+' — sample documents only; payment and printing are simulated</div>'):kioskHtml);
      if(req.method==="GET" && url.pathname==="/app.js")return send(res,200,"text/javascript; charset=utf-8",kioskSource);
      if(req.method==="GET" && url.pathname==="/config.js")return send(res,200,"text/javascript; charset=utf-8",`window.PRINTING_KIOSK_CONFIG=${JSON.stringify({backendUrl:config.localOrigin,publicFrontendUrl:config.localOrigin,localAgentUrl:config.preview?config.localOrigin:config.agent,kioskId:config.preview?"LOCAL-KIOSK":config.kioskId,testHooks:false})};`);
      if(url.pathname.startsWith("/api/") || url.pathname.startsWith("/mobile-upload/")){
        if(!config.preview)return await proxyBackend(req,res,url);
        if(req.method==="GET" && ["/api/kiosk/config","/api/public/services"].includes(url.pathname))return json(res,200,{services:[],pricing:{},kiosk:{kioskId:"LOCAL-KIOSK"}});
        return json(res,404,{error:"Unavailable in isolated local preview"});
      }
      if(req.method==="GET" && (url.pathname.startsWith("/assets/") || ["/styles.css","/responsive.css","/ui-icons.js"].includes(url.pathname))){
        const filename=path.resolve(config.frontend,"."+decodeURIComponent(url.pathname));
        if(!filename.startsWith(config.frontend+path.sep)||!TYPES[path.extname(filename)]||!fs.existsSync(filename))throw new Failure("NOT_FOUND",404);
        const real=fs.realpathSync(filename);if(!real.startsWith(frontendReal+path.sep))throw new Failure("NOT_FOUND",404);
        return send(res,200,TYPES[path.extname(filename)],fs.readFileSync(real));
      }
      throw new Failure("NOT_FOUND",404);
    }catch(error){
      if(res.headersSent)return res.destroy();
      const status=error instanceof Failure?error.status:500,code=error instanceof Failure?error.code:"INTERNAL_ERROR";
      options.log?.({session:session?.id.slice(0,8)||"request",state:code});
      if(url?.pathname.startsWith("/digilocker/") || (url?.pathname.endsWith("/select") && !(req.headers["content-type"]||"").startsWith("application/json")))return html(res,status,phone.result(session?.language||"en",config,false,code));
      return json(res,status,{error:code});
    }
  });
  server.requestTimeout=20000;server.headersTimeout=10000;server.maxHeadersCount=50;
  const sweep=setInterval(()=>store.sweep().catch(()=>{}),60000);sweep.unref();
  server.on("close",()=>clearInterval(sweep));
  return {server,store,kioskKey,select,close:async()=>{clearInterval(sweep);await store.close();await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});}};
}
module.exports={createService};
