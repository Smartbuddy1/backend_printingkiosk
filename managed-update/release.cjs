'use strict';
// Offline signing/build tool. It never uploads, publishes or starts a kiosk.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const p=require('./protocol.cjs');
function build({version,channel,downloadUrl,backend,keyId='primary',privateKey,files,targetKioskIds,notes=''}){
  if(!targetKioskIds?.length)throw Error('Explicit target kiosk IDs required');
  const bundle={format:p.FORMAT,version,files:files.map(f=>({file:f.file,from:f.from,sha256:p.sha(f.bytes),data:f.bytes.toString('base64')}))};
  const bytes=Buffer.from(JSON.stringify(bundle));
  if(backend)downloadUrl=backend+'/api/kiosk/managed-update/artifacts/'+p.sha(bytes)+'.pkupdate';
  const manifest={format:p.FORMAT,version,channel,downloadUrl,sha256:p.sha(bytes),sizeBytes:bytes.length,signingKeyId:keyId,signatureAlgorithm:'RSA-SHA256',targetKioskIds,rolloutPercentage:0,active:false,mandatory:false,notes};
  manifest.signature=crypto.sign('RSA-SHA256',p.signedBytes(manifest),privateKey).toString('base64');
  p.verifyBundle(bytes,manifest,{[keyId]:crypto.createPublicKey(privateKey).export({type:'spki',format:'pem'})});
  return {manifest,bytes};
}
function main(){
  const specFile=process.argv[2];if(!specFile)throw Error('Usage: node managed-update/release.cjs release-spec.json');
  const spec=JSON.parse(fs.readFileSync(specFile,'utf8'));
  const key=crypto.createPrivateKey({key:fs.readFileSync(spec.privateKeyFile),passphrase:process.env.KIOSK_SIGNING_PASSPHRASE});
  const files=spec.files.map(f=>({file:f.file,from:f.from,bytes:fs.readFileSync(f.source)}));
  const built=build({...spec,privateKey:key,files});
  const out=path.resolve(spec.output);if(fs.existsSync(out))throw Error('Refusing to overwrite a release');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'application.pkupdate'),built.bytes,{flag:'wx'});
  fs.writeFileSync(path.join(out,'release.json'),JSON.stringify(built.manifest,null,2),{flag:'wx'});
  fs.writeFileSync(path.join(out,'release.pkrelease'),JSON.stringify({manifest:built.manifest,artifact:built.bytes.toString('base64')}),{flag:'wx'});
  console.log(JSON.stringify({output:out,version:spec.version,sha256:built.manifest.sha256,published:false}));
}
if(require.main===module)main();
module.exports={build};
