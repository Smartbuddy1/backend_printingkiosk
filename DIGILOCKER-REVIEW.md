# Separate frontend and backend source review

Version 1.2.19-dev.6 preserves the dev.5 UI and adds a reproducible export into
the user's separate frontend and backend repositories. This is a source review,
not a production release or an operational EC2 integration.

The frontend changes are merged with the repository's existing reporting and
translation changes, rather than replacing them with the older release snapshot.
The backend lockfile is synchronized with its declared dependencies.

The export is additive on the backend: it adds the DigiLocker feature service,
mock launcher and tests. It does not replace the deployed backend server, its
startup command, database configuration, payments, or printer integration.
The frontend receives the versioned UI source and assets. Its existing build
and deployment configuration are preserved. The compact DigiLocker button is
injected by the local feature service; a static frontend upload alone does not
activate it.

## Local review from the two repositories

Clone the matching review branch of each repository into sibling directories
named `frontend` and `backend`. In `backend`, run:

```text
npm ci --ignore-scripts
npm run test:digilocker
npm run demo:digilocker
```

Open the URL printed by the demo. The launcher ignores environment credentials
and uses local sample documents, simulated payment and simulated printing.
It does not start the existing backend. Stop it with Ctrl+C.

## Hosted integration still required

The current feature service owns pairing state, phone cookies, OAuth state,
tokens and document buffers in the same process as its local kiosk API. The
local kiosk boundary intentionally rejects public kiosk calls. Moving only its
callback to EC2 would break that relationship. A separately configured staging
integration must connect authenticated kiosks to that session service before
the public callback can be used. HTTPS, approved requester credentials and
government API verification are also outstanding.

Do not merge this review into a live branch or restart EC2 expecting DigiLocker
to work. Pulling `main` will not retrieve a separate review branch. No real
credentials, customer uploads, runtime state, or deployment secrets are exported.

## Validation

- Version workspace: 8 isolation/timeout checks and 26 DigiLocker checks passed.
- Split backend checkout with its sibling frontend: clean npm install and all
  25 API/cleanup checks passed. The printer-source overlay check stays in the
  version workspace because the EC2 package does not include the local printer.
- Split checkout browser flow passed consent, document selection, preview,
  simulated payment/printing, deletion, languages and inactivity expiry.
- No government API calls, real payments, printers or EC2 services were tested.
