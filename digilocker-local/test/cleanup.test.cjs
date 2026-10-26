"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),fsp=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {create}=require("../integration/transient-files.cjs");
test("transient print files have owned paths and are deleted on completion/failure and expiry",async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),"digilocker-cleanup-test-"));let now=0;const files=create({parent:root,ttl:1000,now:()=>now});
  t.after(async()=>{await files.close();const verified=path.resolve(root);assert.ok(verified.startsWith(path.resolve(os.tmpdir())+path.sep));await fsp.rm(verified,{recursive:true,force:true});});
  const ordinary=path.join(root,"ordinary-job.pdf");await fsp.writeFile(ordinary,"keep");
  const a=await files.allocate("job-a",".pdf");await fsp.writeFile(a,"private");const job={filePath:a,temporaryFile:true};await files.release("job-a",job);
  assert.equal(fs.existsSync(a),false);assert.equal(job.filePath,null);assert.equal(job.temporaryFile,false);
  const b=await files.allocate("job-b",".png");await fsp.writeFile(b,"private");now=1001;await files.sweep();assert.equal(fs.existsSync(b),false);assert.equal(await fsp.readFile(ordinary,"utf8"),"keep");
  assert.equal(files.owns(ordinary),false);assert.equal(files.owns(path.join(root,"../outside.pdf")),false);
  await assert.rejects(files.allocate("job",".exe"));
});
