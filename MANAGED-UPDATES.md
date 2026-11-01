# Managed kiosk updates: backend deployment

This adds authenticated update APIs and a developer CLI. It does not add an
option to Super Admin or automatically publish a release. Existing rc.4/rc.5
kiosks need the one-time managed updater enablement before they can receive files.

## On the backend server

Run inside the existing `backend_printingkiosk` checkout, as the account that runs
the backend. Keep its existing `.env`, database, uploads and process manager.

```sh
git status --short
git pull --ff-only origin main
npm ci --ignore-scripts
npm run setup:kiosk-updates -- https://api.theaaryatechnologies.com
npm run test:kiosk-updates
```

If pull reports local changes or divergence, preserve those changes and resolve
them before continuing. Do not reset or clean the server checkout. No new runtime
dependencies were introduced by this feature.

The setup command validates the bundled **public** key, creates persistent
`.managed-update/artifacts/`, and writes just these three settings in `.env`:

```text
MANAGED_UPDATE_PUBLIC_KEYS_FILE=<checkout>/managed-update/public-keys.json
MANAGED_UPDATE_ARTIFACT_DIR=<checkout>/.managed-update/artifacts
MANAGED_UPDATE_PUBLIC_BASE=https://api.theaaryatechnologies.com
```

Other settings are retained. A changed existing `.env` is backed up with restricted
permissions under `.managed-update/`. This directory is Git-ignored and must be
backed up along with the database. Do not run setup as root if the backend uses a
different service account. Existing process-manager environment overrides must
agree with these settings.

Restart only the existing backend process using its current process manager.
For PM2, identify the actual backend process with `pm2 list`, then:

```sh
pm2 restart <backend-process-name> --update-env
curl -fsS https://api.theaaryatechnologies.com/api/health
curl -i https://api.theaaryatechnologies.com/api/kiosk/managed-update/check
```

The health route should return HTTP 200. The check route without a kiosk identity
should return HTTP 400 (`Kiosk ID and device identity are required.`), not 404.
This proves route deployment only; it does not prove a kiosk is enrolled.
If the service uses systemd or another manager, use its existing named service
instead of starting a second Node/PM2 process.

Allow at least 90 MiB bodies and suitable upload timeouts on the existing
reverse proxy for `/api/super-admin/managed-update/artifacts`; route that path
to the backend, retaining its authentication. The artifact download path
`/api/kiosk/managed-update/artifacts/` must also reach the backend without a SPA
rewrite. Validate the proxy configuration before reloading it. A 413 on upload
means the proxy request-body limit still needs adjustment.

## Enable KIOSK-03 once

Use the separately prepared `KIOSK-03-managed-rollout-cli.zip` on the Mini PC.
Finish customer jobs, pause and exit the kiosk, then run
`enablement/ENABLE-AUTO-UPDATE.bat` under its existing Windows account with
elevation. It accepts the supported rc.4/rc.5 profiles and requires the kiosk setup
code. Resume the kiosk after setup. The kit enrolls KIOSK-03 on the staging channel
for the first device rollout. Real process, printing and payment acceptance still
must be completed on that PC; the automated tests do not exercise its hardware.

The kit's public key matches `managed-update/public-keys.json`. Do not replace the
key with an unrelated key. No private signing key is included in this repository
or kit. The private key remains on the developer laptop.

## Push from the development laptop

Run from `kiosk-versions/workspaces/v1.2.20-dev.1` (or a backend checkout with the
CLI and your own signed release file):

```powershell
npm.cmd run kiosk:update -- status --server https://api.theaaryatechnologies.com --kiosk KIOSK-03
npm.cmd run kiosk:update -- push --server https://api.theaaryatechnologies.com --kiosk KIOSK-03 --release .publish/KIOSK-03-managed-rollout-cli/release.pkrelease --dry-run
npm.cmd run kiosk:update -- push --server https://api.theaaryatechnologies.com --kiosk KIOSK-03 --release .publish/KIOSK-03-managed-rollout-cli/release.pkrelease
npm.cmd run kiosk:update -- status --server https://api.theaaryatechnologies.com --kiosk KIOSK-03
```

The terminal prompts for the existing Super Admin login with a hidden password.
No browser option is required. For automation, supply a short-lived admin session
through `KIOSK_UPDATE_ADMIN_TOKEN` using your secret store. Do not paste tokens or
passwords into shell arguments, source control or chat.

`push` uploads and queues the signed artifact for only the specified kiosk. The
device waits for idle, verifies the signature and installed-file prerequisites,
and rolls back if application startup fails. Inspect the reported status and
last check-in; a successful upload alone does not mean installation succeeded.
The first supplied release changes the two-service CSS layout only. It does not
represent every source change as an installer. Future changes need a newly built,
signed higher-version release with correct prior-file hashes.

To stop new applications for this kiosk:

```powershell
npm.cmd run kiosk:update -- pause --server https://api.theaaryatechnologies.com --kiosk KIOSK-03
```

An installation already in progress completes or rolls back. Do not downgrade
the server while a managed rollout is active; pause first. There is no schema
migration in this change: kiosk enrollment and release records use the existing
persistence machinery. JSON persistence is covered by tests; live RDS persistence
and the actual Mini PC remain deployment acceptance checks.

## Tests

`npm run test:kiosk-updates` tests the exact repository server source in a
disposable loopback sandbox with temporary keys and data, blocked outbound
connections, disabled subprocesses and no `.env` loading. It never starts the
checkout's production service. Coverage includes authenticated upload, tampering,
enrollment/device binding, persistence across restart, explicit CLI targets,
repeated push, pause, legacy-manifest exclusion and configuration preservation.
