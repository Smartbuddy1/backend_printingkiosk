'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { makeConfig, loadLocalEnv } = require('../digilocker-local/config.cjs');
const { hostedConfig } = require('../digilocker-hosted/config.cjs');
function checkConfig(env, { hosted = false } = {}) {
  if (env.DIGILOCKER_MODE !== 'live') throw new Error('The configuration must explicitly select live mode.');
  if (env.DIGILOCKER_ENABLED !== 'true') throw new Error('DIGILOCKER_ENABLED must be true for an activation check.');
  return hosted ? hostedConfig(env) : makeConfig(env);
}
function main(args = process.argv.slice(2)) {
  const hosted = args[0] === '--hosted';
  if (hosted) args = args.slice(1);
  if (args.length && !(args.length === 2 && args[0] === '--env' && args[1])) throw new Error('Usage: check-digilocker-config.cjs [--hosted] [--env PATH]');
  // Hosted defaults to its dedicated service environment, never the backend .env.
  // An explicit file is parsed alone, without inherited credentials.
  let env = process.env;
  if (args.length || !hosted) {
    const file = args.length ? path.resolve(args[1]) : path.resolve(__dirname, '../digilocker-local/.env');
    if (!fs.existsSync(file)) throw new Error('Configuration file not found. Prepare a dedicated environment from the matching config example.');
    env = loadLocalEnv(file);
  }
  const config = checkConfig(env, { hosted });
  console.log('Configuration structure is valid. No API calls were made; credentials are not verified.');
  console.log(`Provider: ${new URL(config.endpoints.authorize).origin}`);
  console.log(`Register this exact HTTPS callback: ${config.redirectUri}`);
  if (hosted) {
    console.log(`Allowed browser origins: ${config.allowedOrigins.join(', ')}`);
    console.log(`Kiosk policy backend: ${config.backend}`);
  }
  console.log('Next: approved staging sign-in, consent, document retrieval and cancellation tests; verify the kiosk service assignment.');
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { checkConfig, main };
