'use strict';
const crypto=require('node:crypto'),fs=require('node:fs');
const protocol=require('./protocol.cjs');
const artifacts=require('./artifacts.cjs');
const statuses=new Set(['current','available','downloading','deferred','installing','updated','failed','rollback']);
const digest=t=>crypto.createHash('sha256').update(t).digest('hex');
function keys(){const file=process.env.MANAGED_UPDATE_PUBLIC_KEYS_FILE;if(!file)throw Error('Managed update public keys are not configured on this server');return JSON.parse(fs.readFileSync(file,'utf8'));}
function validate(release,kiosks,existing){
  try{
    protocol.verifyManifest(release,keys());
    artifacts.exists(release);
    if(!release.targetKioskIds?.length)throw Error('Select at least one kiosk; automatic fleet rollout is disabled');
    if(release.targetKioskIds.some(id=>!kiosks.some(k=>k.kioskId===id)))throw Error('A selected kiosk does not exist');
    if(existing&&['format','version','downloadUrl','sha256','signature','sizeBytes','signingKeyId','channel'].some(k=>release[k]!==existing[k]))throw Error('Published artifact is immutable; create a new release');
    return '';
  }catch(error){return error.message;}
}
function choose(releases,kiosk,version,channel){
  return releases.filter(r=>r.format===protocol.FORMAT&&r.active&&r.channel===channel&&r.targetKioskIds?.includes(kiosk.kioskId))
    .filter(r=>protocol.compare(r.version,version)>0).sort((a,b)=>protocol.compare(b.version,a.version))[0]||null;
}
async function handle(req,res,url,body,{db,validateSetup,validateDevice,save,json}) {
  const send=(status,data)=>{json(res,status,data);return true;};
  // Caller has already required a Super Admin session for this prefix.
  if(req.method==='POST'&&url.pathname==='/api/super-admin/managed-update/artifacts'){
    try{artifacts.store(body.manifest,body.artifact,keys());return send(201,{ok:true,sha256:body.manifest.sha256});}catch(error){return send(400,{error:error.message});}
  }
  if(!url.pathname.startsWith('/api/kiosk/managed-update/'))return false;
  if(artifacts.serve(req,res,url))return true;
  if(req.method==='POST'&&url.pathname.endsWith('/enroll')){
    const setup=validateSetup(body);if(setup.error)return send(setup.status,{error:setup.error});
    const device=validateDevice(body);if(device.error)return send(device.status,{error:device.error});
    if(!['staging','production'].includes(body.channel))return send(400,{error:'Select staging or production'});
    try{keys();}catch(error){return send(503,{error:error.message});}
    const token=crypto.randomBytes(32).toString('hex'),old={...device.kiosk};
    Object.assign(device.kiosk,{managedUpdateTokenHash:digest(token),managedUpdateChannel:body.channel,managedUpdateEnabled:true,managedUpdateEnrolledAt:new Date().toISOString()});
    if(!(await save())?.ok){Object.keys(device.kiosk).forEach(k=>delete device.kiosk[k]);Object.assign(device.kiosk,old);return send(502,{error:'Could not save updater enrollment'});}
    return send(200,{ok:true,kioskId:device.kioskId,token,channel:body.channel});
  }
  const input=req.method==='GET'?Object.fromEntries(url.searchParams):body;
  const device=validateDevice(input);if(device.error)return send(device.status,{error:device.error});
  const token=String(req.headers['x-kiosk-update-token']||'');
  if(!/^[a-f0-9]{64}$/.test(token)||!device.kiosk.managedUpdateTokenHash||!crypto.timingSafeEqual(Buffer.from(digest(token)),Buffer.from(device.kiosk.managedUpdateTokenHash)))return send(403,{error:'Updater authentication required'});
  if(input.channel!==device.kiosk.managedUpdateChannel)return send(403,{error:'Update channel does not match enrollment'});
  if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.currentVersion||''))return send(400,{error:'Installed release version required'});
  if(req.method==='GET'&&url.pathname.endsWith('/check')){
    let release;try{release=choose(db.releases,device.kiosk,input.currentVersion,input.channel);if(release)protocol.verifyManifest(release,keys());}catch(error){return send(503,{error:error.message});}
    device.kiosk.managedUpdateLastCheckAt=new Date().toISOString();device.kiosk.managedVersion=input.currentVersion;
    if(!(await save())?.ok)return send(502,{error:'Could not save update check'});
    return send(200,{updateAvailable:!!release,manifest:release?Object.fromEntries(['format','version','channel','downloadUrl','sha256','signature','signatureAlgorithm','signingKeyId','sizeBytes','releaseId'].map(k=>[k,release[k]])):null});
  }
  if(req.method==='POST'&&url.pathname.endsWith('/status')){
    if(!statuses.has(input.status))return send(400,{error:'Unknown update status'});
    Object.assign(device.kiosk,{managedVersion:input.currentVersion,managedUpdateStatus:input.status,managedUpdateTarget:String(input.targetVersion||'').slice(0,64),managedUpdateError:String(input.error||'').slice(0,300),managedUpdateLastCheckAt:new Date().toISOString()});
    if(!(await save())?.ok)return send(502,{error:'Could not save update status'});
    return send(200,{ok:true});
  }
  return send(404,{error:'Unknown updater operation'});
}
module.exports={validate,choose,handle};
