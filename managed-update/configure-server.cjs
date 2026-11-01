'use strict';
// Run once from the backend checkout as its service user. Does not restart services.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { atomic, plain } = require('./transaction.cjs');
function configure(root, publicBase) {
  root = plain(root);
  const url = new URL(publicBase);
  if (url.protocol !== 'https:' || url.origin !== publicBase) throw Error('Provide a plain HTTPS origin without a trailing slash.');
  const keyFile = plain(root, 'managed-update/public-keys.json');
  const keys = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  if (!Object.keys(keys).length) throw Error('Public trust key is missing.');
  for (const pem of Object.values(keys)) {
    if (pem.includes('PRIVATE KEY')) throw Error('Only public keys belong on the server.');
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072) throw Error('Invalid public key.');
  }
  const artifactDir = plain(root, '.managed-update/artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.accessSync(artifactDir, fs.constants.W_OK);
  const values = { MANAGED_UPDATE_PUBLIC_KEYS_FILE: keyFile, MANAGED_UPDATE_ARTIFACT_DIR: artifactDir, MANAGED_UPDATE_PUBLIC_BASE: publicBase };
  const envFile = plain(root, '.env');
  const before = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?MANAGED_UPDATE_(?:PUBLIC_KEYS_FILE|ARTIFACT_DIR|PUBLIC_BASE)\s*=/.test(line));
  while (lines.at(-1) === '') lines.pop();
  const after = [...lines, ...Object.entries(values).map(([k, v]) => `${k}=${JSON.stringify(v)}`), ''].join(newline);
  if (after !== before) {
    if (before) {
      const backup = plain(root, '.managed-update/env-' + crypto.randomUUID() + '.backup');
      fs.writeFileSync(backup, before, { flag: 'wx', mode: 0o600 });
    }
    atomic(envFile, after);
    fs.chmodSync(envFile, 0o600);
  }
  return { configured: true, restartRequired: true, publicBase, artifactDir };
}
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw Error('Usage: npm run setup:kiosk-updates -- https://api.theaaryatechnologies.com');
    console.log(JSON.stringify(configure(path.resolve(__dirname, '..'), process.argv[2]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { configure };
