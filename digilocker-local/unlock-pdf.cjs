"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const { Failure } = require("./security.cjs");
const { validateDocument } = require("./documents.cjs");
let active = 0;
async function unlockPdf(bytes, password, config, signal) {
  if (signal?.aborted) throw new Failure("SESSION_ENDED",410);
  if (!config.pdfUnlock || process.platform !== "linux") throw new Failure("PDF_UNLOCK_UNAVAILABLE",503);
  if (typeof password !== "string" || !password || password.length > 256 || /[\r\n\0]/.test(password)) throw new Failure("PDF_PASSWORD_INCORRECT",400);
  if (!Buffer.isBuffer(bytes) || bytes.length > config.maxBytes) throw new Failure("FILE_TOO_LARGE",413);
  if (active >= 2) throw new Failure("BUSY",503);
  active++;
  let output;
  try {
    output = await new Promise((resolve,reject)=>{
      const child=spawn("/usr/bin/python3",["-I","-B",path.join(__dirname,"unlock-pdf.py"),String(config.maxBytes)],{detached:true,stdio:["pipe","pipe","pipe"],env:{PATH:"/usr/bin:/bin",LANG:"C.UTF-8"}});
      const chunks=[]; let size=0, failure=null;
      const stop=error=>{failure ||= error;try{process.kill(-child.pid,"SIGKILL");}catch{}};
      const abort=()=>stop(new Failure("SESSION_ENDED",410));
      const timer=setTimeout(()=>stop(new Failure("PDF_UNLOCK_FAILED",415)),12000);
      signal?.addEventListener("abort",abort,{once:true});
      if(signal?.aborted)abort();
      child.stderr.resume(); // Never forward tool diagnostics.
      child.stdout.on("data",chunk=>{size+=chunk.length;if(size>config.maxBytes){chunk.fill(0);stop(new Failure("FILE_TOO_LARGE",413));}else chunks.push(chunk);});
      child.on("error",()=>{failure=new Failure("PDF_UNLOCK_UNAVAILABLE",503);});
      child.stdin.on("error",()=>{});
      child.on("close",code=>{
        clearTimeout(timer);signal?.removeEventListener("abort",abort);
        try {
          if(failure)throw failure;
          if(code!==0)throw new Failure(({10:"PDF_PASSWORD_INCORRECT",12:"FILE_TOO_LARGE",13:"PDF_UNLOCK_UNAVAILABLE"})[code]||"PDF_UNLOCK_FAILED",415);
          resolve(Buffer.concat(chunks,size));
        } catch(error){reject(error);} finally {for(const chunk of chunks)chunk.fill(0);}
      });
      const header=Buffer.from(JSON.stringify({password}));password=null;
      const length=Buffer.alloc(4);length.writeUInt32BE(header.length);
      child.stdin.write(length);child.stdin.write(header,()=>header.fill(0));child.stdin.end(bytes);
    });
    const checked=await validateDocument(output,"application/pdf",config,signal);
    return {bytes:output,...checked,size:output.length};
  } catch(error){output?.fill(0);throw error;} finally{active--;}
}
module.exports={unlockPdf};
