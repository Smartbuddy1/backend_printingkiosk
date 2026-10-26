"use strict";
const path=require("node:path"),vm=require("node:vm");const {once}=require("./overlay.cjs");
function agentOverlay(source,origin="http://127.0.0.1:5081"){
  const newline=source.includes("\r\n")?"\r\n":"\n";
  let s=once(source,"loadEnv();","// The local DigiLocker runner supplies its own environment.","agent env loader");
  s=once(s,'const TEMP_DIR = path.join(os.tmpdir(), "printing-kiosk-jobs");','const TEMP_DIR = path.join(os.tmpdir(), "printing-kiosk-digilocker-local-" + PORT);\nlet digilockerTemp;',"agent temp");
  const cache='const IDLE_MEDIA_CACHE_DIR = process.env.ProgramData'+newline+'  ? path.join(process.env.ProgramData, "SmartPrintingKioskMediaCache", "idle-media")'+newline+'  : path.join(os.tmpdir(), "printing-kiosk-idle-media-cache");';
  s=once(s,cache,'const IDLE_MEDIA_CACHE_DIR = path.join(TEMP_DIR,"unused-media-cache");',"agent cache");
  s=once(s,'const filePath = path.join(TEMP_DIR, `${safeFileName(jobId)}-${crypto.randomBytes(4).toString("hex")}${extension}`);','const filePath = await digilockerTemp.allocate(jobId,extension);',"agent file allocation");
  s=once(s,"if (job.temporaryFile && job.filePath) {","if (job.temporaryFile && job.filePath && !digilockerTemp.owns(job.filePath)) {","agent successful cleanup");
  const final='    throw error;'+newline+'  }'+newline+'}'+newline+newline+'let globalPrintQueue = Promise.resolve();';
  s=once(s,final,'    throw error;'+newline+'  } finally {'+newline+'    body.fileContentBase64 = ""; body.fileUrl = "";'+newline+'    await digilockerTemp.release(job.jobId,job);'+newline+'  }'+newline+'}'+newline+newline+'let globalPrintQueue = Promise.resolve();',"agent final cleanup");
  s=once(s,'if (req.method === "POST" && url.pathname === "/local/print") {',`if (req.method === "POST" && url.pathname === "/local/print") {\n    if (body.digilockerTransient !== true || req.headers.origin !== ${JSON.stringify(origin)} || body.filePath || !body.fileContentBase64) return json(res,403,{error:"Only the local DigiLocker kiosk may submit transient documents."});`,"agent submit boundary");
  // Disable retry and all other mutations: deleted documents must be paired again.
  s=once(s,'const body = req.method === "POST" ? await readBody(req) : {};','const body = req.method === "POST" ? await readBody(req) : {};\n  if (req.method === "POST" && url.pathname !== "/local/print") return json(res,403,{error:"Not available in the isolated DigiLocker agent."});',"agent write boundary");
  // Acquire the port before startup cleanup; a second launcher must not erase an active job.
  s=once(s,"server.listen(PORT, () => {",`server.listen(PORT, "127.0.0.1", () => {\n  digilockerTemp = require(${JSON.stringify(path.join(__dirname,"transient-files.cjs"))}).create({parent:TEMP_DIR,ttl:Number(process.env.DIGILOCKER_SESSION_TTL_MINUTES||10)*60000});`,"agent listen");
  const registryStart='  // Disable Windows Print Spooler notification popups';
  const start=s.indexOf(registryStart),end=s.indexOf("  scheduleDeviceRefresh();",start);
  if(start<0||end<start)throw new Error("Unsupported agent startup source");
  s=s.slice(0,start)+s.slice(end);
  s+='\nfor (const signal of ["SIGINT","SIGTERM"]) process.on(signal,async()=>{await digilockerTemp?.close();process.exit(0);});\n';
  new vm.Script(s,{filename:"local-digilocker-printer-agent.js"});return s;
}
module.exports={agentOverlay};
