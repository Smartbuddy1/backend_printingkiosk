"use strict";
const { makeConfig, loadLocalEnv } = require("./config.cjs");
const { createService } = require("./server.cjs");
const { createMock } = require("./mock/server.cjs");

function listen(server, port, host = "127.0.0.1") {
  return new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,host,()=>{server.off("error",reject);resolve(server.address().port);});});
}
async function startStack(config, options = {}) {
  let mock, app;
  try {
    if (config.enabled && config.mode === "mock") {
      mock = createMock(config,options.mock);
      const port = await listen(mock.server,config.mockPort);
      for (const key of Object.keys(config.endpoints)) { const u = new URL(config.endpoints[key]); u.port=String(port); config.endpoints[key]=u.href; }
    }
    app=createService(config,options);
    const port=await listen(app.server,config.port,config.listenHost);
    const oldOrigin=config.localOrigin;config.localOrigin=`http://${config.listenHost}:${port}`;
    if(config.publicBase===oldOrigin){config.publicBase=config.localOrigin;config.redirectUri=`${config.publicBase}/digilocker/callback`;}
    return {app,mock,config,close:async()=>{await app.close();if(mock)await new Promise(resolve=>{mock.server.close(resolve);mock.server.closeIdleConnections();});}};
  } catch(error){if(app)await app.close();if(mock)await new Promise(resolve=>mock.server.close(resolve));throw error;}
}
async function main() {
  // Never invoke the project's load-env.js or import its server/database code.
  const env={...loadLocalEnv(),...process.env};
  if(process.argv.includes("--mock")){env.DIGILOCKER_ENABLED="true";env.DIGILOCKER_MODE="mock";env.DIGILOCKER_LOCAL_PREVIEW="true";}
  const config=makeConfig(env);
  const stack=await startStack(config,{log:event=>console.log(`[DigiLocker] ${event.session} ${event.state}`)});
  console.log(`Local kiosk: ${config.localOrigin}`);
  console.log(`DigiLocker: ${config.enabled?config.mode:"disabled"}; existing project files unchanged.`);
  if(config.preview)console.log("Local preview uses sample documents and simulated payment/printing.");
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await stack.close();process.exit(0);};
  process.on("SIGINT",close);process.on("SIGTERM",close);
}
if(require.main===module)main().catch(error=>{console.error(`DigiLocker startup failed: ${error.message}`);process.exitCode=1;});
module.exports={startStack,listen};
