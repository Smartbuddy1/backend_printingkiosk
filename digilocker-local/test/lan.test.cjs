'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { makeConfig, privateIPv4 } = require('../config.cjs');
const { startStack } = require('../start.cjs');
const { Provider } = require('../provider.cjs');
const flow = require('./flow.cjs');
const host = Object.values(os.networkInterfaces()).flat().find(n => n.family === 'IPv4' && !n.internal && privateIPv4(n.address))?.address;

test('Wi-Fi HTTP is restricted to explicit private-address mock preview; live keeps HTTPS and credential requirements', () => {
  for (const value of ['8.8.8.8','0.0.0.0','192.168.1.999','localhost']) {
    assert.throws(() => makeConfig({DIGILOCKER_LAN_DEMO:'true',DIGILOCKER_LAN_HOST:value}), /private IPv4/);
  }
  assert.throws(() => makeConfig({DIGILOCKER_LAN_DEMO:'true',DIGILOCKER_LAN_HOST:'192.168.1.28',DIGILOCKER_MODE:'live'}), /requires mock/);
  assert.throws(() => makeConfig({DIGILOCKER_LAN_DEMO:'true',DIGILOCKER_LAN_HOST:'192.168.1.28',DIGILOCKER_LOCAL_PREVIEW:'false'}), /requires mock/);
  const live = {DIGILOCKER_ENABLED:'true',DIGILOCKER_MODE:'live',DIGILOCKER_LOCAL_PREVIEW:'false',DIGILOCKER_CLIENT_ID:'test-id',DIGILOCKER_CLIENT_SECRET:'test-secret',PUBLIC_BASE_URL:'https://staging.example.test',DIGILOCKER_REDIRECT_URI:'https://staging.example.test/digilocker/callback',DIGILOCKER_KIOSK_ID:'STAGING-TEST'};
  const config = makeConfig(live);
  const authorize = new URL(new Provider(config).authorize({state:'test-state',challenge:'test-challenge'}));
  assert.equal(authorize.origin,'https://digilocker.meripehchaan.gov.in');
  assert.equal(authorize.searchParams.get('redirect_uri'), live.DIGILOCKER_REDIRECT_URI);
  assert.equal(authorize.searchParams.get('client_id'), 'test-id');
  assert.equal(authorize.searchParams.get('client_secret'), null);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.throws(() => makeConfig({...live,PUBLIC_BASE_URL:'http://127.0.0.1:5081',DIGILOCKER_REDIRECT_URI:'http://127.0.0.1:5081/digilocker/callback'}), /HTTPS/);
  assert.throws(() => makeConfig({...live,DIGILOCKER_REDIRECT_URI:'https://other.example.test/digilocker/callback'}), /exactly match/);
});

test('Wi-Fi mock sends usable private-IP QR URLs and keeps token/document APIs private', {skip:!host}, async t => {
  const config=makeConfig({DIGILOCKER_ENABLED:'true',DIGILOCKER_LAN_DEMO:'true',DIGILOCKER_LAN_HOST:host,DIGILOCKER_PORT:'0',DIGILOCKER_MOCK_PORT:'0'});
  const stack=await startStack(config,{version:'test'});
  t.after(()=>stack.close());
  assert.equal(stack.mock.server.address().address,'127.0.0.1');
  const origin=stack.config.localOrigin;
  assert.equal((await fetch(origin+'/')).status,200);
  const settings=await (await fetch(origin+'/config.js')).text();
  assert.ok(settings.includes(host));
  assert.ok(!settings.includes('api.theaaryatechnologies.com'));
  for(const route of ['/__mock-provider/public/oauth2/2/token','/__mock-provider/public/oauth2/1/file/private','/.env','/admin','/api/admin/login']) {
    assert.equal((await fetch(origin+route)).status,404);
  }
  assert.equal((await fetch(origin+'/digilocker/runtime.js',{headers:{origin:'https://other.example'}})).status,403);
  assert.equal((await fetch(origin+'/digilocker/runtime.js',{headers:{'x-forwarded-host':'external.example'}})).status,403);
  const session=await flow.create(stack);
  assert.ok(session.qrUrl.startsWith(origin+'/digilocker/start/'));
  const phone=await flow.connect(stack,session);
  assert.equal(phone.uris.length,3);
  assert.equal((await flow.select(stack,session,phone)).status,200);
  assert.equal((await flow.status(stack,session)).status,'READY');
  assert.equal(stack.mock.audit.revoked,1);
  await flow.complete(stack,session,'cancelled');
  assert.equal(stack.app.store.reserved,0);
});
