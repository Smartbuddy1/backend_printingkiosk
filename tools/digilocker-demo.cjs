'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeConfig, privateIPv4 } = require('../digilocker-local/config.cjs');
const version = require('../version.json');

function networkAddress(requested) {
  const entries = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => entries
    .filter(item => item.family === 'IPv4' && !item.internal && privateIPv4(item.address))
    .map(item => ({ name, address: item.address })));
  if (requested) {
    if (!entries.some(item => item.address === requested)) throw new Error('Requested private IP is not assigned to this PC.');
    return requested;
  }
  const wifi = entries.filter(item => /wi-?fi|wireless|wlan/i.test(item.name));
  if (wifi.length === 1) return wifi[0].address;
  if (entries.length !== 1) throw new Error('Specify the Wi-Fi IPv4 address: npm run demo:wifi -- --host 192.168.1.28');
  return entries[0].address;
}
async function main() {
  const args = process.argv.slice(2);
  const wifi = args.includes('--wifi');
  const index = args.indexOf('--host');
  const host = wifi ? networkAddress(index >= 0 ? args[index + 1] : undefined) : '127.0.0.1';
  if (index >= 0 && (!wifi || !args[index + 1])) throw new Error('--host requires --wifi and an address.');
  // This launcher deliberately ignores all .env files, live credentials and URLs.
  for (const name of Object.keys(process.env)) {
    if (!/^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|OS)$/i.test(name)) delete process.env[name];
  }
  process.env.NODE_ENV = 'development';
  const config = makeConfig({
    DIGILOCKER_ENABLED: 'true', DIGILOCKER_MODE: 'mock', DIGILOCKER_LOCAL_PREVIEW: 'true',
    DIGILOCKER_LAN_DEMO: String(wifi), DIGILOCKER_LAN_HOST: host,
    DIGILOCKER_PORT: String(version.digilockerPort), DIGILOCKER_MOCK_PORT: String(version.digilockerMockPort)
  });
  const { startStack } = require('../digilocker-local/start.cjs');
  const stack = await startStack(config, { version: version.version });
  const runtime = path.resolve(__dirname, '../.runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'digilocker-demo.json'), JSON.stringify({
    version: version.version, pid: process.pid, url: config.localOrigin, mode: 'mock',
    startedAt: new Date().toISOString(), wifi, node: process.execPath
  }, null, 2));
  console.log(`DigiLocker ${version.version}: ${config.localOrigin}`);
  console.log('Sample documents only. No real DigiLocker login, payment, physical printing or live kiosk backend.');
  console.log('On the same Wi-Fi: open this URL, choose DigiLocker, and open the phone page or scan the QR.');
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await stack.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  process.on('message', message => { if (message === 'stop') void close(); });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { networkAddress };
