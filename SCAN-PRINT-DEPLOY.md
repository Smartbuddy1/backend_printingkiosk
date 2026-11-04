# Scan & Print backend update

Pull main, run npm ci --ignore-scripts, and restart printing-kiosk-backend.service using systemctl. Existing database, .env, activation and upload data are preserved. Do not restart unrelated PM2 applications.

Service normalization now persists mode scan independently of its name and recognizes legacy service ID scan. Deploy the companion frontend and build it with npm run build:production to show Scan & Print in Super Admin. Capture is a local Windows bridge operation; this EC2 endpoint returns 503 rather than invoking hardware.

Validation: npm run test:kiosk-updates includes an isolated copy of the actual server with outbound networking and subprocesses disabled. It checks scan service persistence/disable and the unavailable cloud capture endpoint, plus update enrollment/auth/signing/targeting/persistence.
