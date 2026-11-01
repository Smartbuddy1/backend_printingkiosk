'use strict';
// Exported-backend acceptance test. Runs exact server bytes in a disposable sandbox.
// Never starts a server from the checkout or reads its .env/settings/customer state.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { build } = require('../release.cjs'), cli = require('../cli.cjs');
const root = path.resolve(__dirname, '../..');

test('deployment backend: auth, enrollment, signed upload, CLI target/pause, persistence and legacy isolation', { timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-deploy-test-'));
  fs.mkdirSync(path.join(dir, 'managed-update'));
  for (const name of ['server.js', 'rds-store.js']) fs.copyFileSync(path.join(root, name), path.join(dir, name));
  for (const name of ['backend.cjs', 'protocol.cjs', 'artifacts.cjs', 'transaction.cjs']) fs.copyFileSync(path.join(root, 'managed-update', name), path.join(dir, 'managed-update', name));
  // .env loading is disabled only in the disposable fixture, never in shipped source.
  fs.writeFileSync(path.join(dir, 'load-env.js'), 'exports.loadEnv = () => ({});');
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ primary: pair.publicKey.export({ type: 'spki', format: 'pem' }) }));
  fs.writeFileSync(path.join(dir, 'start.cjs'), `
    const net=require('node:net');
    net.Socket.prototype.connect=function(){throw Error('Test blocks all outbound network');};
    const cp=require('node:child_process');
    for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>{throw Error('Test blocks hardware/subprocesses');};
    const listen=net.Server.prototype.listen;
    net.Server.prototype.listen=function(...args){this.once('listening',()=>process.send({port:this.address().port}));return listen.apply(this,args);};
    process.on('message',m=>{if(m==='stop')process.exit(0);});
    require('./server.js');
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|OS)$/i.test(name)));
  Object.assign(env, {
    NODE_PATH: path.join(root, 'node_modules'), NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0',
    ADMIN_EMAIL: 'fixture-admin@example.test', ADMIN_PASSWORD: 'fixture-password-123',
    SUPER_ADMIN_EMAIL: 'fixture-super@example.test', SUPER_ADMIN_PASSWORD: 'fixture-super-password-123',
    DATA_PATH: path.join(dir, 'data.json'), SETTINGS_PATH: path.join(dir, 'settings.json'),
    ADMIN_SESSIONS_PATH: path.join(dir, 'sessions.json'), MOBILE_UPLOAD_SESSIONS_PATH: path.join(dir, 'mobile.json'),
    MANAGED_UPDATE_PUBLIC_KEYS_FILE: path.join(dir, 'keys.json'), MANAGED_UPDATE_ARTIFACT_DIR: path.join(dir, 'artifacts'),
    MANAGED_UPDATE_PUBLIC_BASE: 'https://updates.example.test'
  });
  let child, origin, ended, output = '';
  const stop = async () => { if (child?.connected) child.send('stop'); if (ended) await ended; };
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, ['start.cjs'], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    ended = new Promise(resolve => child.once('exit', resolve));
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('Fixture startup timeout: ' + output)); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(Error(output)); });
      child.once('message', ({ port }) => { clearTimeout(timer); resolve('http://127.0.0.1:' + port); });
    });
  };
  await start();
  const req = async (route, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const health = await req('/api/health'); assert.equal(health.data.persistence, 'local-json');
  const login = await req('/api/auth/login', { email: env.SUPER_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD });
  assert.equal(login.status, 200); const token = login.data.token, admin = { Authorization: 'Bearer ' + token };
  const snapshot = (await req('/api/super-admin/snapshot', undefined, admin)).data.data;
  let projectId = snapshot.projects[0]?.projectId;
  if (!projectId) {
    const adminId = snapshot.kioskAdmins[0]?.adminId;
    assert.ok(adminId, 'Fixture must have a default kiosk admin');
    const project = await req('/api/super-admin/projects', { projectId: 'CLI-PROJECT', name: 'Fixture project', adminId }, admin);
    assert.equal(project.status, 201, JSON.stringify(project.data)); projectId = project.data.record.projectId;
  }
  const ids = ['CLI-KIOSK-03', 'CLI-KIOSK-04'], deviceId = 'a'.repeat(64), setupCode = 'FIXTURE-123';
  for (const kioskId of ids) {
    assert.equal((await req('/api/super-admin/kiosks', { kioskId, name: 'Test fixture', projectId, setupCode }, admin)).status, 201);
    assert.equal((await req('/api/kiosk/setup/activate', { kioskId, setupCode, deviceId })).status, 200);
  }
  const identity = { kioskId: ids[0], deviceId, channel: 'staging' };
  assert.equal((await req('/api/kiosk/managed-update/enroll', { ...identity, setupCode: 'WRONG' })).status, 403);
  const enrolled = await req('/api/kiosk/managed-update/enroll', { ...identity, setupCode }); assert.equal(enrolled.status, 200);
  const auth = { 'x-kiosk-update-token': enrolled.data.token };
  const built = build({ version: '1.2.20-rc.1', channel: 'staging', backend: 'https://updates.example.test', privateKey: pair.privateKey,
    files: [{ file: 'resources/app/frontend/responsive.css', from: [null], bytes: Buffer.from('body{}') }], targetKioskIds: [ids[1]] });
  const payload = { manifest: built.manifest, artifact: built.bytes.toString('base64') };
  const file = path.join(dir, 'release.pkrelease'); fs.writeFileSync(file, JSON.stringify(payload));
  assert.equal((await req('/api/super-admin/managed-update/artifacts', payload)).status, 401);
  assert.equal((await req('/api/super-admin/releases', { ...built.manifest, active: true }, admin)).status, 400);
  assert.equal((await req('/api/super-admin/managed-update/artifacts', { ...payload, artifact: Buffer.from('bad').toString('base64') }, admin)).status, 400);
  const opts = { server: origin, kiosk: ids[0], local: true, release: file, command: 'push', dryRun: true };
  await cli.execute(opts, { token, log: () => {} });
  assert.equal((await req('/api/super-admin/snapshot', undefined, admin)).data.data.releases.length, 0);
  opts.dryRun = false;
  await cli.execute(opts, { token, log: () => {} }); await cli.execute(opts, { token, log: () => {} });
  const records = (await req('/api/super-admin/snapshot', undefined, admin)).data.data.releases;
  assert.equal(records.length, 1); assert.deepEqual(records[0].targetKioskIds, [ids[0]]);
  const downloaded = await fetch(origin + new URL(built.manifest.downloadUrl).pathname);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), built.bytes);
  const route = '/api/kiosk/managed-update/check?' + new URLSearchParams({ ...identity, currentVersion: '1.2.19-rc.5' });
  assert.equal((await req(route)).status, 403);
  assert.equal((await req(route, undefined, auth)).data.manifest.version, built.manifest.version);
  assert.equal((await req('/api/kiosk/update/manifest?' + new URLSearchParams({ ...identity, currentVersion: '1.2.19-rc.5' }))).data.updateAvailable, false);
  assert.equal((await req('/api/kiosk/managed-update/status', { ...identity, currentVersion: '1.2.19-rc.5', status: 'deferred' }, auth)).status, 200);
  assert.equal((await req('/api/kiosk/managed-update/status', { ...identity, kioskId: ids[1], currentVersion: '1.2.19-rc.5', status: 'updated' }, auth)).status, 403);
  await stop(); await start();
  assert.equal((await req(route, undefined, auth)).data.manifest.version, built.manifest.version);
  opts.server = origin;
  await cli.execute({ ...opts, command: 'pause' }, { token, log: () => {} });
  assert.equal((await req(route, undefined, auth)).data.manifest, null);
  assert.equal((await req('/api/super-admin/releases/' + records[0].releaseId, { version: '9.0.0' }, admin, 'PATCH')).status, 400);
});
