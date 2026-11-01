'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {sha,allowedFile}=require('./protocol.cjs');
function plain(root, relative='') {
  root=path.resolve(root);const dest=path.resolve(root,relative);
  if(dest!==root&&!dest.startsWith(root+path.sep))throw Error('Path escaped installation');
  let current=dest;
  for(;;){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Linked update path refused');const parent=path.dirname(current);if(parent===current)break;current=parent;}
  return dest;
}
function atomic(file,bytes) {
  plain(path.dirname(file),path.basename(file));fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx');
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);
}
const writeJSON=(f,o)=>atomic(f,JSON.stringify(o,null,2));
const readJSON=(f,fallback=null)=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):fallback;
function prepare(root,state,bundle,manifest) {
  plain(root);plain(state);
  if(readJSON(path.join(state,'pending.json')))throw Error('An update already needs recovery');
  const id=crypto.randomUUID(),dir=plain(state,id);fs.mkdirSync(dir,{recursive:true});
  const rows=bundle.files.map((f,i)=>{
    const dest=plain(root,f.file),old=fs.existsSync(dest)?fs.readFileSync(dest):null;
    if(!f.from.includes(old===null?null:sha(old)))throw Error('Installed file differs: '+f.file);
    if(old!==null)atomic(path.join(dir,i+'.old'),old);
    atomic(path.join(dir,i+'.new'),Buffer.from(f.data,'base64'));
    return {file:f.file,old:old===null?null:sha(old),next:f.sha256};
  });
  const tx={id,phase:'prepared',manifest,rows,previous:readJSON(path.join(state,'installed.json'))};
  writeJSON(path.join(state,'pending.json'),tx);return tx;
}
function validate(tx){
  if(!/^[a-f0-9-]{36}$/.test(tx.id)||!Array.isArray(tx.rows)||!tx.rows.length||tx.rows.some(r=>!allowedFile(r.file)))throw Error('Invalid recovery journal');
}
function apply(root,state,tx,afterWrite=()=>{}) {
  validate(tx);const dir=plain(state,tx.id);
  // Verify every prerequisite and staged file again before touching installed files.
  for(const [i,r] of tx.rows.entries()){
    const dest=plain(root,r.file),old=fs.existsSync(dest)?sha(fs.readFileSync(dest)):null;
    if(old!==r.old||sha(fs.readFileSync(plain(dir,i+'.new')))!==r.next)throw Error('Staged/prerequisite file changed');
    if(r.old!==null&&sha(fs.readFileSync(plain(dir,i+'.old')))!==r.old)throw Error('Backup changed');
  }
  tx.phase='applying';writeJSON(path.join(state,'pending.json'),tx);
  for(const [i,r] of tx.rows.entries()){
    const dest=plain(root,r.file);atomic(dest,fs.readFileSync(plain(dir,i+'.new')));
    if(sha(fs.readFileSync(dest))!==r.next)throw Error('Installed hash mismatch');afterWrite(i);
  }
  tx.phase='testing';writeJSON(path.join(state,'pending.json'),tx);
}
function rollback(root,state,tx) {
  validate(tx);const dir=plain(state,tx.id);
  for(const [i,r] of tx.rows.entries())if(r.old!==null&&sha(fs.readFileSync(plain(dir,i+'.old')))!==r.old)throw Error('Recovery backup invalid; keep kiosk stopped');
  for(const [i,r] of tx.rows.entries()){
    const dest=plain(root,r.file);
    if(r.old===null){if(fs.existsSync(dest))fs.unlinkSync(dest);}else atomic(dest,fs.readFileSync(plain(dir,i+'.old')));
    if((fs.existsSync(dest)?sha(fs.readFileSync(dest)):null)!==r.old)throw Error('Recovery verification failed');
  }
  writeJSON(path.join(state,'installed.json'),tx.previous);
  writeJSON(path.join(state,'last-result.json'),{status:'rollback',version:tx.manifest.version,sha256:tx.manifest.sha256,time:new Date().toISOString()});
  fs.unlinkSync(plain(state,'pending.json'));
}
function commit(root,state,tx) {
  validate(tx);
  for(const r of tx.rows)if(sha(fs.readFileSync(plain(root,r.file)))!==r.next)throw Error('Post-start file changed');
  writeJSON(path.join(state,'installed.json'),{version:tx.manifest.version,sha256:tx.manifest.sha256});
  tx.phase='committed';writeJSON(path.join(state,'pending.json'),tx);
  writeJSON(path.join(state,'last-result.json'),{status:'updated',version:tx.manifest.version,time:new Date().toISOString()});
  fs.unlinkSync(plain(state,'pending.json'));
}
function recover(root,state){const tx=readJSON(plain(state,'pending.json'));if(!tx)return;if(tx.phase==='committed'){validate(tx);writeJSON(path.join(state,'installed.json'),{version:tx.manifest.version,sha256:tx.manifest.sha256});fs.unlinkSync(path.join(state,'pending.json'));}else rollback(root,state,tx);}
function discardPrepared(state,journal){validate(journal);if(journal.phase!=='prepared')throw Error('Cannot discard an applied transaction');fs.unlinkSync(plain(state,'pending.json'));}
module.exports={plain,atomic,writeJSON,readJSON,prepare,apply,rollback,commit,recover,discardPrepared};
