# Hosted DigiLocker callback

This is a separate Node service for an HTTPS reverse proxy. It never starts the
printing backend, loads its environment, connects to its database, or runs the mock
provider. Use `node digilocker-hosted/start.cjs` with a dedicated environment file
based on `config.example`. It listens only on 127.0.0.1 (default port 5091).

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

Super Admin > Kiosks > Edit > Kiosk Customer Print Options includes a DigiLocker
checkbox alongside B/W and colour. It is unchecked for new and existing kiosks
until explicitly enabled. The setting is stored in `customerSettings.digilocker`
using the existing kiosk persistence; no database schema migration is needed.
The kiosk-admin summary also displays this setting.

The hosted frontend hides the DigiLocker button when unchecked. New sessions carry
the configured kiosk ID, and the callback service independently checks the saved
setting through the existing loopback backend `/api/kiosk/config`. Missing,
unknown or disabled kiosks are rejected; backend lookup failures fail closed.
The setting is checked for each new session, without a stale policy cache.
Sessions already accepted may finish so disabling a service does not interrupt
an in-progress paid job. This switch does not replace the global credential and
approval requirements. The isolated mock preview retains its demo button.
