# Printing Kiosk 1.2.20-rc.4: operator deployment

The frontend and Mini-PC setup carry the direct DigiLocker preview, printing
animation and offline-entry fix. This repository now also contains the current
hosted DigiLocker provider, PDF-password and phone-flow code, including the latest
phone completion text. Existing main-server public payment URL fixes are retained.
`server.js` is unchanged in this release. No database migration is required.

## Pull the backend source

Run as `ec2-user` on the existing API EC2 server:

```sh
cd /home/ec2-user/backend_printingkiosk
git status --short
git pull --ff-only origin main
NODEBIN=/home/ec2-user/printing-kiosk-digilocker/runtimes/node-v24.22.3-linux-x64/bin
PATH="$NODEBIN:$PATH" npm ci --omit=dev --ignore-scripts
"$NODEBIN/node" --test digilocker-hosted/test/hosted.test.cjs tools/mobile-payment-url.test.cjs
```

Stop if the checkout has unexpected local changes or any command fails. Keep
the existing `.env`, database, uploads and managed-update state. This release does
not require restarting the main payment/backend service.

## Update the separate DigiLocker service

The current systemd service runs an immutable directory under
`/home/ec2-user/printing-kiosk-digilocker/releases/`. A backend `git pull` does
**not** change that active directory. Use the following steps only when there
are no customers pairing/authorizing/sending documents; its restart ends in-memory
DigiLocker sessions. Main payments are served by a different service.

Stage a new directory from the committed checkout, without copying credentials:

```sh
set -e
cd /home/ec2-user/backend_printingkiosk
test -z "$(git status --porcelain)"
REV=$(git rev-parse --short=12 HEAD)
BASE=/home/ec2-user/printing-kiosk-digilocker
RELEASE="$BASE/releases/$REV"
NODEBIN="$BASE/runtimes/node-v24.22.3-linux-x64/bin"
test -x "$NODEBIN/node"
test -x /usr/bin/qpdf
test -x /usr/bin/python3
test ! -e "$RELEASE"
mkdir "$RELEASE"
git archive HEAD package.json package-lock.json digilocker-local digilocker-hosted | tar -x -C "$RELEASE"
cd "$RELEASE"
PATH="$NODEBIN:$PATH" npm ci --omit=dev --ignore-scripts
"$NODEBIN/node" --test digilocker-hosted/test/hosted.test.cjs digilocker-hosted/test/password-native.test.cjs
```

All hosted and Linux native PDF tests must pass. The ordinary Windows development
test suite also exercises the local/mock stack; those full-source tests need the
frontend and printer source tree and are not the hosted release acceptance suite.
Keep the existing dedicated environment file; do not put it in the release or Git.

In the same shell, back up the currently active override and activate the release:

```sh
OVERRIDE=/etc/systemd/system/printing-kiosk-digilocker.service.d/20-release.conf
BACKUP="$BASE/rollback/$(date -u +%Y%m%dT%H%M%SZ)-$REV"
mkdir -m 700 "$BACKUP"
printf 'Rollback backup: %s\n' "$BACKUP"
sudo test -f "$OVERRIDE"
sudo cp -p "$OVERRIDE" "$BACKUP/20-release.conf"
printf '[Service]\nWorkingDirectory=%s\nExecStart=\nExecStart=%s/node %s/digilocker-hosted/start.cjs\n' "$RELEASE" "$NODEBIN" "$RELEASE" > "$BACKUP/new-release.conf"
sudo install -m 644 "$BACKUP/new-release.conf" "$OVERRIDE"
sudo systemctl daemon-reload
sudo systemctl restart printing-kiosk-digilocker.service
sudo systemctl is-active printing-kiosk-digilocker.service
curl --fail --silent --show-error http://127.0.0.1:5091/digilocker/health
curl --fail --silent --show-error https://api.theaaryatechnologies.com/digilocker/health
```

Both health responses must report `ready:true`. If restart or readiness fails,
restore the prior override immediately using the same `BACKUP` and `OVERRIDE`:
If your shell exited, first set those variables again using the printed backup
path and the override path above.

```sh
sudo cp -p "$BACKUP/20-release.conf" "$OVERRIDE"
sudo systemctl daemon-reload
sudo systemctl restart printing-kiosk-digilocker.service
```

Old releases, Node runtime and `/etc/printing-kiosk-digilocker.env` remain intact.
Do not restart or reconfigure the main backend/nginx to fix a failed dedicated
service rollout. Investigate the failed release separately.

## Website and Mini PC

Pull `Smartbuddy1/frontend_printingkiosk`, run `npm run build:production`, and serve
its `dist/` at the existing website path. See that repository's `DEPLOY-rc4.md`.
Use `PrintingKiosk-1.2.20-rc.4-Full-Setup.zip` for Mini PCs, extract everything and
run `SETUP.bat` > Install / Update. Do not uninstall first. Check the installed
version, startup offline, reconnect, DigiLocker Send, printing and reboot on the
target. Package verification does not establish physical installation or printing.
