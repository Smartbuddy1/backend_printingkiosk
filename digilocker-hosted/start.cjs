"use strict";
const { hostedConfig } = require("./config.cjs");
const { createService } = require("../digilocker-local/server.cjs");
const { parserPreflight } = require("./preflight.cjs");
async function main() {
  // systemd supplies the dedicated environment file. Never load the existing
  // backend .env, database, payment credentials, or local mock runner.
  const config=hostedConfig(process.env);
  if(config.enabled)await parserPreflight(config);
  const app=createService(config,{log:entry=>console.log(JSON.stringify(entry))});
  await new Promise((resolve,reject)=>{app.server.once("error",reject);app.server.listen(config.port,"127.0.0.1",resolve);});
  console.log(`DigiLocker callback service listening on loopback:${config.port}; ${config.enabled?"live authorization configured":"awaiting approved credentials; authorization disabled"}`);
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;const timeout=setTimeout(()=>process.exit(1),20000);timeout.unref();await app.close();process.exit(0);};
  process.on("SIGTERM",close);process.on("SIGINT",close);
}
if(require.main===module)main().catch(error=>{console.error(error.code==="PDF_PARSER_UNAVAILABLE"?"DigiLocker PDF parser startup check failed. Use the validated service Node runtime and parser assets.":"DigiLocker service startup failed. Check the dedicated configuration and listener; no credentials are logged.");process.exitCode=1;});
module.exports={main};
