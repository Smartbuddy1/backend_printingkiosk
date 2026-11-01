'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const p=require('./protocol.cjs'),{plain}=require('./transaction.cjs');
function location(m){
  const root=process.env.MANAGED_UPDATE_ARTIFACT_DIR,base=process.env.MANAGED_UPDATE_PUBLIC_BASE;
  if(!root||!base||new URL(base).protocol!=='https:'||new URL(base).origin!==base)throw Error('Managed update artifact storage/public HTTPS origin is not configured');
  if(m.downloadUrl!==`${base}/api/kiosk/managed-update/artifacts/${m.sha256}.pkupdate`)throw Error('Release URL must use this server and the artifact SHA-256');
  if(!/^[a-f0-9]{64}$/.test(m.sha256))throw Error('Invalid artifact hash');
  return plain(root,m.sha256+'.pkupdate');
}
function exists(m){const file=location(m);if(!fs.existsSync(file)||fs.statSync(file).size!==m.sizeBytes||p.sha(fs.readFileSync(file))!==m.sha256)throw Error('Upload the signed update file before publishing');return file;}
function store(m,base64,keys){
  if(typeof base64!=='string'||base64.length>Math.ceil(p.LIMIT/3)*4)throw Error('Update package too large');
  const bytes=Buffer.from(base64,'base64');p.verifyBundle(bytes,m,keys);const file=location(m);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)){exists(m);return;}
  const temp=plain(path.dirname(file),crypto.randomUUID()+'.tmp'),fd=fs.openSync(temp,'wx');
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);
}
function serve(req,res,url){
  const match=/^\/api\/kiosk\/managed-update\/artifacts\/([a-f0-9]{64})\.pkupdate$/.exec(url.pathname);
  if(!match)return false;
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return true;}
  const root=process.env.MANAGED_UPDATE_ARTIFACT_DIR;if(!root){res.writeHead(503);res.end();return true;}
  const file=plain(root,match[1]+'.pkupdate');
  if(!fs.existsSync(file)){res.writeHead(404);res.end();return true;}
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':fs.statSync(file).size,'Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'});
  if(req.method==='HEAD')res.end();else fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
  return true;
}
module.exports={location,exists,store,serve};
