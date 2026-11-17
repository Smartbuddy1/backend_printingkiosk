"use strict";
// Optional REAL printer launcher. Never used by mock mode or automated tests.
const fs=require("node:fs"),path=require("node:path"),Module=require("node:module");
const {ROOT,makeConfig,loadLocalEnv}=require("./config.cjs");const {agentOverlay}=require("./integration/agent-overlay.cjs");
function main(){
  const env={...loadLocalEnv(),...process.env};
  if(!process.argv.includes("--print"))throw new Error("This launcher operates a real Windows printer. Run with --print only for an intentional local printer test.");
  if(env.DIGILOCKER_ENABLED!=="true"||env.DIGILOCKER_LOCAL_PREVIEW!=="false")throw new Error("Enable DigiLocker and disable simulated preview in the feature-local .env first");
  const config=makeConfig(env);
  const original=path.resolve(ROOT,env.DIGILOCKER_PRINTER_SOURCE||"mini-pc/release/SmartPrintingKiosk-win-x64/resources/app/local-agent/printerAgent.js");
  const modified=agentOverlay(fs.readFileSync(original,"utf8"),config.localOrigin);
  // Drop inherited network configuration. No root .env or database is loaded.
  for(const key of Object.keys(process.env))if(/^(BACKEND_|PUBLIC_|FRONTEND_|DATABASE_|POSTGRES_|KIOSK_|AWS_|RAZORPAY_|SNMP_|START_)/.test(key))delete process.env[key];
  process.env.BACKEND_URL="";process.env.KIOSK_ID="";process.env.AGENT_PORT=String(new URL(config.agent).port);process.env.DIGILOCKER_SESSION_TTL_MINUTES=String(config.sessionTtl/60000);
  if(!process.env.AGENT_PORT||Number(process.env.AGENT_PORT)===5077)throw new Error("Use a separate local agent port, e.g. 5079");
  console.log("Starting the existing Windows print implementation with isolated DigiLocker temporary files.");
  const compiled=new Module(original,module);compiled.filename=original;compiled.paths=Module._nodeModulePaths(path.dirname(original));compiled._compile(modified,original);
}
if(require.main===module){try{main();}catch(error){console.error(`Local printer startup failed: ${error.message}`);process.exitCode=1;}}
