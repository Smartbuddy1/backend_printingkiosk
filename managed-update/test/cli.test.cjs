'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const cli = require('../cli.cjs'), { build } = require('../release.cjs');
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey;

test('CLI requires one explicit kiosk and HTTPS; local test cannot redirect credentials', () => {
  for (const args of [
    ['push', '--local-test', '--release', 'a'],
    ['status', '--kiosk', '*', '--local-test'],
    ['status', '--kiosk', 'KIOSK-03,KIOSK-04', '--local-test'],
    ['status', '--kiosk', 'KIOSK-03', '--server', 'http://example.com'],
    ['status', '--kiosk', 'KIOSK-03', '--server', 'https://user:pass@example.com'],
    ['status', '--kiosk', 'KIOSK-03', '--local-test', '--server', 'https://example.com'],
    ['status', '--kiosk', 'KIOSK-03', '--local-test', '--password', 'secret']
  ]) assert.throws(() => cli.parse(args, {}));
  assert.equal(cli.parse(['status', '--kiosk', 'kiosk-03', '--local-test'], { KIOSK_UPDATE_SERVER: 'https://example.com' }).server,
    'http://127.0.0.1:' + require('../../version.json').frontendPort);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-cli-'));
  // Only this freshly allocated test directory is removed.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const built = build({ version: '1.2.20-rc.2', channel: 'staging', backend: 'https://updates.example.test', privateKey: key,
    files: [{ file: 'resources/app/frontend/responsive.css', from: [null], bytes: Buffer.from('body{}') }], targetKioskIds: ['KIOSK-04'] });
  const file = path.join(dir, 'release.pkrelease');
  fs.writeFileSync(file, JSON.stringify({ manifest: built.manifest, artifact: built.bytes.toString('base64') }));
  const options = cli.parse(['push', '--local-test', '--kiosk', 'KIOSK-03', '--release', file]);
  const data = { kiosks: [{ kioskId: 'KIOSK-03', managedUpdateEnabled: true, managedUpdateChannel: 'staging', managedVersion: '1.2.19-rc.5' }], releases: [] };
  const calls = [];
  const call = async (server, route, request) => {
    calls.push({ route, ...request });
    if (route.endsWith('/snapshot')) return { data };
    if (route === '/api/super-admin/releases') data.releases.push({ ...request.body });
    if (request.method === 'PATCH') Object.assign(data.releases.find(r => route.endsWith(r.releaseId)), request.body);
    return { ok: true };
  };
  const execute = opts => cli.execute({ ...options, ...opts }, { token: 'test-token', call, log: () => {} });
  return { options, data, calls, execute, file };
}

test('CLI dry-run does not upload; push isolates kiosk and repeat push is idempotent', async t => {
  const f = fixture(t);
  await f.execute({ dryRun: true });
  assert.deepEqual(f.calls.map(c => c.method), ['GET']);
  await f.execute({}); await f.execute({});
  assert.equal(f.data.releases.length, 1);
  assert.deepEqual(f.data.releases[0].targetKioskIds, ['KIOSK-03']);
  assert.equal(f.data.releases[0].rolloutPercentage, 0);
  await f.execute({ command: 'pause', dryRun: true });
  assert.equal(f.data.releases[0].active, true);
  await f.execute({ command: 'pause' });
  assert.equal(f.data.releases[0].active, false);
});

test('CLI refuses wrong channel, downgrade, unknown kiosk, shared pause and wrong-server packages', async t => {
  const f = fixture(t);
  await assert.rejects(f.execute({ kiosk: 'UNKNOWN' }), /does not exist/);
  f.data.kiosks[0].managedUpdateChannel = 'production';
  await assert.rejects(f.execute({}), /channel differs/);
  f.data.kiosks[0].managedUpdateChannel = 'staging';
  f.data.kiosks[0].managedVersion = '9.0.0';
  await assert.rejects(f.execute({}), /newer/);
  f.data.releases.push({ format: 'printing-kiosk-files-v1', active: true, targetKioskIds: ['KIOSK-03', 'KIOSK-04'] });
  await assert.rejects(f.execute({ command: 'pause' }), /shared rollout/);
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
  assert.throws(() => cli.readPackage(f.file, { server: 'https://wrong.example' }), /different server/);
  const payload = JSON.parse(fs.readFileSync(f.file)); payload.artifact = Buffer.from('tampered').toString('base64');
  fs.writeFileSync(f.file, JSON.stringify(payload));
  assert.throws(() => cli.readPackage(f.file, f.options), /hash\/size/);
});

test('CLI never sends live environment token in local test login', async () => {
  let sent;
  const token = await cli.authenticate({ local: true, server: 'http://127.0.0.1:15380' }, { KIOSK_UPDATE_ADMIN_TOKEN: 'live-secret' },
    async (server, route, options) => { sent = options; return { token: 'local-token' }; });
  assert.equal(token, 'local-token'); assert.equal(sent.token, undefined);
  assert.equal(sent.body.password, 'local-super-admin-password');
});
