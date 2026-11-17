# Hosted DigiLocker callback

This is a separate Node service for an HTTPS reverse proxy. It never starts the
printing backend, loads its environment, connects to its database, or runs the mock
provider. Use `node digilocker-hosted/start.cjs` with a dedicated environment file
based on `config.example`. It listens only on 127.0.0.1 (default port 5091).

Use the validated Node 24 runtime for this service. Node 20 lacks
`Promise.withResolvers`, which the bundled PDF worker uses: even a valid,
unencrypted one-page PDF failed on the EC2 Node 20 runtime. Keep the DigiLocker
runtime separate from the existing backend runtime. Run the hosted tests with the
same absolute Node executable used in systemd, not whichever `node` is on PATH.
Enabled startup now opens a generated one-page PDF with the actual worker before
binding its listener; missing or incompatible parser assets prevent readiness.
No customer data or provider calls are involved in this check.

Password-protected PDFs use an optional Linux phone flow:
`DIGILOCKER_PDF_UNLOCK=true` requires `/usr/bin/python3` with `os.memfd_create`
and `/usr/bin/qpdf` (tested with 10.6.3). Run `npm run test:pdf-password` with the
service Node runtime before activation. Windows skips the native helper tests.
The provider HMAC is verified before retaining encrypted bytes. The provider
token is revoked before password entry; documents stay unavailable to the kiosk
until all selected PDFs are decrypted and validated. Customers enter their PDF
opening password on the same paired phone, never their DigiLocker PIN or OTP.
Passwords travel only in HTTPS POST and private process pipes, not command-line
arguments, environment, logs or persistent files. The Linux helper uses anonymous
memory file descriptors, bounded resources and a process-group timeout/cancel.
Wrong passwords can be retried up to five times per document. Phone inactivity,
cancellation and session expiry clear retained files. Successful output is parsed
again with the usual MIME, size and page limits before preview/print handoff.

Proxy `/digilocker/` and `/api/digilocker/` to this listener, preserving Host,
X-Real-IP and X-Forwarded-Proto. Disable access logs for these routes so authorization
codes, state and pairing URLs are not retained in access logs. Do not proxy unrelated
application routes. Test Nginx configuration before reloading it.

With DIGILOCKER_ENABLED=false the public `/digilocker/callback` page responds 200
and explicitly says approval/activation is pending. `/digilocker/health` reports
ready=false; authorization APIs return 503 DIGILOCKER_NOT_READY. A successful page
load is not government approval and does not validate OAuth interoperability.

After approval, configure the assigned client ID, client secret, exact registered
callback URI and approved document scopes. Review the provider specification and
complete a consent/token/document/revocation test using an authorized account
before enabling customer access. Real government OAuth and physical print cleanup
have not been validated by the automated tests. The existing local printer-agent
integration is a separate deployment; do not claim its transient-file cleanup is
installed merely by deploying this service.

The frontend uses an Origin-bound, short-lived, single-use bootstrap and individual
session secrets. This separates browser sessions; it is not kiosk enrollment or a
device identity check. Only the phone that started the authorization can complete
it, using its Secure HttpOnly cookie and one-use state. Document selection requires
CSRF and same-origin checks. Selected bytes stay in memory, bounded by session and
global limits, and are cleared on completion/cancellation/expiry. Restarting the
service drops pending sessions. Run one process; no shared session store is used.

Offline checks: `node --test digilocker-hosted/test/hosted.test.cjs`. Tests inject
an offline provider and never contact the government API. Do not put real secrets,
uploads, session records or environment files in Git or deployment archives.

## Per-kiosk availability

In Super Admin > Kiosks, use **Add DigiLocker** or **Manage DigiLocker** to assign
the service to a kiosk. Its Enabled setting and kiosk assignment control the customer
card. The standalone DigiLocker checkbox was removed from Kiosk Edit. The backend
derives the legacy `customerSettings.digilocker` property in `/api/kiosk/config`, so
the callback can keep its existing per-kiosk check without a database migration.

New sessions carry the configured kiosk ID, and the callback service independently
checks the assigned service through the existing loopback backend `/api/kiosk/config`.
Missing, unknown or disabled kiosks are rejected; backend lookup failures fail closed.
The setting is checked for each new session, without a stale policy cache. Sessions
already accepted may finish so disabling a service does not interrupt an in-progress
paid job. This assignment does not replace the global credential and approval
requirements. The isolated mock preview retains its demo service card.

## Activation preparation

Use the dedicated hosted environment from `config.example`, not the local mock
environment. Set the actual `DIGILOCKER_KIOSK_BACKEND_URL` explicitly: credentials
alone cannot pass the kiosk assignment check if this backend is unreachable.

Before starting the approved staging service, validate its dedicated environment:

```powershell
npm run digilocker:check-live -- --hosted --env /absolute/path/to/dedicated/.env
```

Alternatively, with the service environment already supplied:
`node tools/check-digilocker-config.cjs --hosted`.
The check makes no network calls, does not print credentials, and does not prove
that credentials or provider permissions have been approved.

See [DIGILOCKER-READINESS.md](../DIGILOCKER-READINESS.md) for the integration audit
and remaining staging checks.
