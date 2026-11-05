const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const helpers = ['publicOrigin', 'publicFrontendOrigin', 'paymentPageUrl'].map(name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const tail = source.slice(start);
  const end = tail.slice(1).search(/\n(?:async )?function /);
  assert.ok(end >= 0);
  return tail.slice(0, end + 1);
}).join('\n');

function paymentUrl(env, host = '127.0.0.1:5082') {
  const ctx = vm.createContext({ URL, process: { env }, PORT: 5082 });
  vm.runInContext(helpers, ctx);
  return new URL(ctx.paymentPageUrl({ headers: { host } }, 'PAY-regression'));
}

test('public phone checkout uses the frontend HTTPS proxy even with internal backend config', () => {
  const url = paymentUrl({ PUBLIC_FRONTEND_URL: 'https://pay.example.test/printingkiosk/?old=value#old', BACKEND_URL: 'http://127.0.0.1:5082' });
  assert.equal(url.origin, 'https://pay.example.test');
  assert.equal(url.pathname, '/printingkiosk/index.html');
  assert.equal(url.searchParams.get('backendUrl'), 'https://pay.example.test');
  assert.equal(url.searchParams.get('mobilePayment'), 'PAY-regression');
  assert.equal(url.searchParams.has('old'), false);
  assert.equal(url.hash, '');
});

test('separate frontend and backend EC2 hosts produce a frontend proxy URL', () => {
  const url = paymentUrl({ PUBLIC_FRONTEND_URL: 'https://pay.example.test/printingkiosk/index.html', BACKEND_URL: 'https://api.example.test' });
  assert.equal(url.searchParams.get('backendUrl'), 'https://pay.example.test');
  assert.equal(url.pathname, '/printingkiosk/index.html');
});

test('local and LAN development retain their own origin', () => {
  for (const host of ['127.0.0.1:15320', '192.168.1.10:15322']) {
    const url = paymentUrl({}, host);
    assert.equal(url.origin, `http://${host}`);
    assert.equal(url.searchParams.get('backendUrl'), url.origin);
  }
});
