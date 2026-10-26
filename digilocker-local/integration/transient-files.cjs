"use strict";
const fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {execFileSync}=require("node:child_process");
function create({parent,ttl=600000,now=Date.now}={}) {
  const absoluteParent=path.resolve(parent),systemTemp=path.resolve(os.tmpdir());
  if(!absoluteParent.toLowerCase().startsWith((systemTemp+path.sep).toLowerCase()))throw new Error("DigiLocker temp parent must be inside the OS temp directory");
  const root=path.join(absoluteParent,"digilocker");
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(fs.lstatSync(root).isSymbolicLink())throw new Error("DigiLocker temp directory cannot be a link");
  if(process.platform==="win32"){
    const account=(process.env.USERDOMAIN?process.env.USERDOMAIN+"\\":"")+os.userInfo().username;
    execFileSync("icacls.exe",[root,"/inheritance:r","/grant:r",`${account}:(OI)(CI)F`,"*S-1-5-18:(OI)(CI)F"],{windowsHide:true,stdio:"ignore"});
  }else fs.chmodSync(root,0o700);
  const allocations=new Map(),filenamePattern=/^dl-[0-9a-f]{32}\.(pdf|jpg|jpeg|png)$/;
  function owns(file){return typeof file==="string" && path.dirname(path.resolve(file))===root && filenamePattern.test(path.basename(file));}
  function unlink(file){if(!owns(file))throw new Error("Refusing a path outside DigiLocker temp files");return fsp.unlink(file).catch(error=>{if(error.code!=="ENOENT")throw error;});}
  // This directory contains only feature-owned generated filenames, never ordinary print jobs.
  for(const entry of fs.readdirSync(root)){const file=path.join(root,entry);if(owns(file)&&fs.lstatSync(file).isFile())fs.unlinkSync(file);}
  async function allocate(jobId,extension){
    if(![".pdf",".png",".jpg",".jpeg"].includes(extension))throw new Error("Unsupported transient print type");
    const file=path.join(root,`dl-${crypto.randomBytes(16).toString("hex")}${extension}`);
    const list=allocations.get(jobId)||[];list.push({file,expires:now()+ttl});allocations.set(jobId,list);
    const handle=await fsp.open(file,"wx",0o600);await handle.close();return file;
  }
  async function release(jobId,job){
    const entries=allocations.get(jobId)||[];
    for(const entry of entries)await unlink(entry.file);
    allocations.delete(jobId);
    if(job&&owns(job.filePath)){job.filePath=null;job.temporaryFile=false;}
  }
  async function sweep(){for(const [id,entries] of allocations){const expired=entries.filter(e=>e.expires<=now());for(const entry of expired)await unlink(entry.file);const remaining=entries.filter(e=>e.expires>now());if(remaining.length)allocations.set(id,remaining);else allocations.delete(id);}}
  const timer=setInterval(()=>sweep().catch(()=>{}),60000);timer.unref();
  return {root,allocate,release,owns,sweep,close:async()=>{clearInterval(timer);for(const id of [...allocations.keys()])await release(id);}};
}
module.exports={create};
