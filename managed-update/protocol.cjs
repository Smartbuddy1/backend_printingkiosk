'use strict';
const crypto = require('node:crypto');
const FORMAT = 'printing-kiosk-files-v1';
const LIMIT = 64 * 1024 * 1024;
const HOOK = "require(require('node:path').join(require('node:path').dirname(process.execPath),'managed-update/app-hook.cjs')).attach({app,getWindow:()=>mainWindow,exit:()=>exitKiosk(75)});";
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function compare(a, b) {
  const parse = v => { const m = versionPattern.exec(v); if (!m) throw Error('Invalid release version'); return {core:m.slice(1,4).map(Number),pre:m[4]?.split('.')}; };
  const x=parse(a),y=parse(b);
  for(let i=0;i<3;i++)if(x.core[i]!==y.core[i])return Math.sign(x.core[i]-y.core[i]);
  if(!x.pre||!y.pre)return x.pre?-1:y.pre?1:0;
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++){
    const l=x.pre[i],r=y.pre[i];if(l===r)continue;if(l===undefined)return -1;if(r===undefined)return 1;
    const ln=/^\d+$/.test(l),rn=/^\d+$/.test(r);
    if(ln&&rn)return Math.sign(Number(l)-Number(r));if(ln!==rn)return ln?-1:1;return l<r?-1:1;
  }return 0;
}
function signedBytes(m) {
  return Buffer.from(JSON.stringify([FORMAT,m.version,m.channel,m.downloadUrl,m.sizeBytes,m.sha256,m.signingKeyId]));
}
function verifyManifest(m, keys) {
  if(m.format!==FORMAT||!versionPattern.test(m.version)||!['staging','production'].includes(m.channel))throw Error('Unsupported release');
  const u=new URL(m.downloadUrl);
  if(u.protocol!=='https:'||u.username||u.password||u.hash)throw Error('Update requires a plain HTTPS URL');
  if(!Number.isSafeInteger(m.sizeBytes)||m.sizeBytes<1||m.sizeBytes>LIMIT||!/^\w[\w.-]{0,63}$/.test(m.signingKeyId)||!/^[a-f0-9]{64}$/.test(m.sha256))throw Error('Invalid artifact metadata');
  const pem=keys[m.signingKeyId];if(!pem)throw Error('Unknown signing key');
  const key=crypto.createPublicKey(pem);
  if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<3072)throw Error('RSA signing key must be at least 3072 bits');
  if(m.signatureAlgorithm!=='RSA-SHA256'||typeof m.signature!=='string'||!crypto.verify('RSA-SHA256',signedBytes(m),key,Buffer.from(m.signature,'base64')))throw Error('Release signature rejected');
  return m;
}
function allowedFile(name) {
  if(typeof name!=='string'||name.length>200||/[\\:\x00-\x1f]/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)))return false;
  if(/^resources\/app\/frontend\/(?:assets\/|digilocker\/)?[A-Za-z0-9_./ -]+\.(?:html|js|cjs|mjs|css|svg|png|jpg|jpeg|webp|woff2?|ttf|pdf)$/.test(name))return !/(?:^|\/)config\.js$/.test(name);
  return ['resources/app/electron/main.js','resources/app/electron/preload.js','resources/app/electron/printerHealthMonitor.js','resources/app/electron/internetMonitor.js','resources/app/local-agent/printerAgent.js','resources/app/local-agent/transient-files.cjs','resources/app/desktop-production/bridge.cjs'].includes(name);
}
function verifyBundle(bytes,m,keys) {
  verifyManifest(m,keys);
  if(bytes.length!==m.sizeBytes||sha(bytes)!==m.sha256)throw Error('Artifact size/hash mismatch');
  const b=JSON.parse(bytes.toString('utf8'));
  if(b.format!==FORMAT||b.version!==m.version||!Array.isArray(b.files)||!b.files.length||b.files.length>500)throw Error('Invalid application bundle');
  const seen=new Set();let total=0;
  for(const f of b.files){
    if(!allowedFile(f.file)||seen.has(f.file.toLowerCase()))throw Error('Unsafe or duplicate application path');seen.add(f.file.toLowerCase());
    if(!Array.isArray(f.from)||!f.from.length||f.from.some(h=>h!==null&&!/^[a-f0-9]{64}$/.test(h)))throw Error('Missing installed-file prerequisites');
    if(typeof f.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data))throw Error('Invalid file encoding');
    const content=Buffer.from(f.data,'base64');total+=content.length;
    if(total>LIMIT||sha(content)!==f.sha256)throw Error('Application file hash mismatch');
    if(f.file==='resources/app/electron/main.js'&&!content.toString('utf8').includes(HOOK))throw Error('Release must preserve managed update integration');
  }
  return b;
}
module.exports={FORMAT,LIMIT,HOOK,sha,compare,signedBytes,verifyManifest,verifyBundle,allowedFile};
