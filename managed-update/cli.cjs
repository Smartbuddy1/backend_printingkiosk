'use strict';
// Developer laptop only. Uses existing authenticated APIs; no Super Admin UI changes.
const fs = require('node:fs');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const protocol = require('./protocol.cjs');
const HELP = `Printing Kiosk developer update CLI
  npm run kiosk:update -- push --kiosk KIOSK-03 --release <release.pkrelease> --server https://<backend>
  npm run kiosk:update -- status --kiosk KIOSK-03 --server https://<backend>
  npm run kiosk:update -- pause --kiosk KIOSK-03 --server https://<backend>

Use --local-test instead of --server for this workspace's isolated preview.
push/pause --dry-run shows the plan without uploading or changing releases.
Live login prompts for email/password, or uses KIOSK_UPDATE_ADMIN_TOKEN.
KIOSK_UPDATE_SERVER can supply the HTTPS origin. Credentials are never saved.
One kiosk per command; repeated pushes reuse that kiosk's release record.
Publish means queued on the server, not installed. Check status for device reports.
`;

function parse(argv, env = process.env) {
  if (!argv.length || argv.includes('--help')) return { help: true };
  const [command, ...rest] = argv;
  if (!['push', 'status', 'pause'].includes(command)) throw Error('Expected push, status or pause. Use --help.');
  const options = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!['--kiosk', '--release', '--server', '--local-test', '--dry-run'].includes(key)) throw Error('Unknown option: ' + key);
    if (Object.hasOwn(options, key)) throw Error('Repeated option: ' + key);
    if (['--local-test', '--dry-run'].includes(key)) options[key] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw Error('Missing value: ' + key);
      options[key] = value;
    }
  }
  const kiosk = String(options['--kiosk'] || '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(kiosk)) throw Error('Specify exactly one --kiosk ID. Fleet/wildcard pushes are disabled.');
  if (command === 'push' && !options['--release']) throw Error('push requires --release <release.pkrelease>.');
  if (command !== 'push' && options['--release']) throw Error('--release is only for push.');
  const local = Boolean(options['--local-test']);
  if (local && options['--server']) throw Error('--local-test cannot be combined with --server.');
  const server = local ? 'http://127.0.0.1:' + require('../version.json').frontendPort : (options['--server'] || env.KIOSK_UPDATE_SERVER);
  if (!server) throw Error('Set --server https://<backend>, or use --local-test.');
  const u = new URL(server);
  if ((!local && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('Server must be a plain HTTPS origin; HTTP is only available with --local-test.');
  return { command, kiosk, local, server: u.origin, release: options['--release'], dryRun: Boolean(options['--dry-run']) };
}

function readPackage(file, options) {
  if (fs.statSync(file).size > Math.ceil(protocol.LIMIT * 4 / 3) + 1024 * 1024) throw Error('Release package too large.');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = payload.manifest;
  if (!m || m.format !== protocol.FORMAT || typeof payload.artifact !== 'string') throw Error('Use a signed .pkrelease bundle.');
  const bytes = Buffer.from(payload.artifact, 'base64');
  if (bytes.length > protocol.LIMIT || bytes.length !== m.sizeBytes || protocol.sha(bytes) !== m.sha256) throw Error('Release artifact hash/size mismatch.');
  const origin = options.local ? 'https://updates.example.test' : options.server;
  if (m.downloadUrl !== origin + '/api/kiosk/managed-update/artifacts/' + m.sha256 + '.pkupdate') throw Error('Release was built for a different server. Rebuild and sign for the intended server.');
  // Signature and file-policy validation are enforced by the pinned server key at upload.
  return payload;
}

async function api(server, route, { token, method = 'GET', body } = {}) {
  const response = await fetch(server + route, {
    method, redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(`HTTP ${response.status}: ${data.error || 'Request failed'}`);
  return data;
}

async function prompt(label, hidden = false) {
  if (!process.stdin.isTTY) throw Error('Interactive login requires a terminal. For automation set KIOSK_UPDATE_ADMIN_TOKEN.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.on('SIGINT', () => { rl.close(); });
    rl.on('close', () => { if (!answered) reject(Error('Login cancelled.')); });
    rl.question(label, answer => { answered = true; muted = false; rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
    muted = hidden;
  });
}

async function authenticate(options, env = process.env, call = api) {
  if (!options.local && env.KIOSK_UPDATE_ADMIN_TOKEN) return env.KIOSK_UPDATE_ADMIN_TOKEN;
  const email = options.local ? 'superadmin@printingkiosk.local' : (await prompt('Admin email: ')).trim();
  const password = options.local ? 'local-super-admin-password' : await prompt('Password (hidden): ', true);
  const login = await call(options.server, '/api/auth/login', { method: 'POST', body: { email, password } });
  if (!login.token) throw Error('Login did not return a session token.');
  return login.token;
}

function releaseId(manifest, kiosk) {
  return 'REL-CLI-' + protocol.sha(Buffer.from(JSON.stringify([manifest.sha256, manifest.channel, kiosk]))).slice(0, 32);
}

async function execute(options, { token, call = api, log = console.log } = {}) {
  const payload = options.command === 'push' ? readPackage(options.release, options) : null;
  const request = (route, method = 'GET', body) => call(options.server, route, { token, method, body });
  const { data } = await request('/api/super-admin/snapshot');
  const kiosk = data?.kiosks?.find(k => k.kioskId === options.kiosk);
  if (!kiosk) throw Error('Kiosk does not exist on this server: ' + options.kiosk);
  const releases = data.releases.filter(r => r.format === protocol.FORMAT && r.targetKioskIds?.includes(options.kiosk));
  log(JSON.stringify({ server: options.server, kiosk: options.kiosk, localTest: options.local, dryRun: options.dryRun }));
  if (options.command === 'status') {
    const result = {
      enrolled: Boolean(kiosk.managedUpdateEnabled), channel: kiosk.managedUpdateChannel || null,
      installedVersion: kiosk.managedVersion || null, deviceStatus: kiosk.managedUpdateStatus || 'not-reported',
      targetVersion: kiosk.managedUpdateTarget || null, lastCheck: kiosk.managedUpdateLastCheckAt || null,
      error: kiosk.managedUpdateError || null,
      releases: releases.map(r => ({ releaseId: r.releaseId, version: r.version, channel: r.channel, active: r.active }))
    };
    log(JSON.stringify(result, null, 2)); return result;
  }
  if (options.command === 'pause') {
    const active = releases.filter(r => r.active);
    // Never pause a shared release for other kiosks as a side effect.
    if (active.some(r => r.targetKioskIds.length !== 1)) throw Error('An active shared rollout targets this kiosk. Split that legacy rollout before using kiosk-only pause. Nothing changed.');
    log(JSON.stringify({ action: 'pause', releases: active.map(r => r.releaseId) }));
    if (!options.dryRun) for (const r of active) await request('/api/super-admin/releases/' + encodeURIComponent(r.releaseId), 'PATCH', { active: false });
    if (!options.dryRun) log('Paused new updates for ' + options.kiosk + '. An installation already in progress may finish.');
    return { paused: !options.dryRun, count: active.length };
  }
  const manifest = payload.manifest;
  if (!options.local && !kiosk.managedUpdateEnabled) throw Error('Enable the updater on this kiosk once before pushing.');
  if (kiosk.managedUpdateChannel && kiosk.managedUpdateChannel !== manifest.channel) throw Error('Release channel differs from kiosk enrollment.');
  if (kiosk.managedVersion && protocol.compare(manifest.version, kiosk.managedVersion) <= 0) throw Error('Release must be newer than the reported installed version.');
  const id = releaseId(manifest, options.kiosk);
  const existing = data.releases.find(r => r.releaseId === id);
  if (existing && (existing.sha256 !== manifest.sha256 || existing.signature !== manifest.signature || existing.targetKioskIds.length !== 1 || existing.targetKioskIds[0] !== options.kiosk)) throw Error('Conflicting release record; nothing changed.');
  log(JSON.stringify({ action: 'push', version: manifest.version, channel: manifest.channel, releaseId: id, targetKioskIds: [options.kiosk] }));
  if (options.dryRun) return { published: false, releaseId: id };
  await request('/api/super-admin/managed-update/artifacts', 'POST', payload);
  if (existing) await request('/api/super-admin/releases/' + encodeURIComponent(id), 'PATCH', { active: true });
  else await request('/api/super-admin/releases', 'POST', {
    ...manifest, releaseId: id, targetKioskIds: [options.kiosk], active: true, rolloutPercentage: 0, mandatory: false
  });
  log('Queued for ' + options.kiosk + '. Installation is not confirmed; run status to see device reports.');
  return { published: true, releaseId: id };
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  // Validate the file before asking for a password or contacting a server.
  if (options.command === 'push') readPackage(options.release, options);
  const token = await authenticate(options);
  await execute(options, { token });
}
if (require.main === module) main().catch(error => { console.error('Kiosk update: ' + error.message); process.exitCode = 1; });
module.exports = { parse, readPackage, authenticate, releaseId, execute, api };
