"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { agentOverlay } = require("../integration/agent-overlay.cjs");
test("agent overlay reuses the original print implementation without changing the packaged file", () => {
  const file = path.join(__dirname, "../../local-agent/printerAgent.js");
  const before = fs.readFileSync(file, "utf8"), after = agentOverlay(before);
  assert.ok(after.includes('server.listen(PORT, "127.0.0.1"'));
  assert.ok(after.includes('await digilockerTemp.release(job.jobId,job)'));
  assert.ok(after.includes('await printWithWindows(prepared.filePath, printerName, job)'));
  assert.ok(after.includes('await waitForWindowsPrintCompletion(printerName, job)'));
  assert.ok(!after.includes('New-ItemProperty -Path'));
  assert.ok(!after.includes('loadEnv();'));
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
