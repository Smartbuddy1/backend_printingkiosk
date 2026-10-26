# Local DigiLocker printing

**Version 1.2.19-dev.2:** use `../DIGILOCKER-WIFI.md` for the authorized mock Wi-Fi
workflow, mobile test link and current credential configuration instructions.
The launcher is `npm run demo:wifi` from the version folder. Source is now in
`frontend/` (the default), not `frontend/dist`. This workspace intentionally keeps
physical printer startup disabled; the optional legacy printer-runner notes below
are architectural reference and are not an enabled hardware test here. The ignored
feature `.env` has not been created; use `config.live.example` after API approval.

This folder adds DigiLocker to a locally served copy of the existing kiosk UI. It reads the existing frontend files and adds integration hooks to HTTP responses; it does not edit those files. It never imports the existing backend, loads the root/backend `.env`, or connects to a database. Existing application launch commands remain unchanged.

## Run the sample flow

From the repository root, using the dependencies already installed:

```powershell
node digilocker-local/start.cjs --mock
```

Open **http://127.0.0.1:5081**. Choose **DigiLocker** in the right corner of Services. Click **Open phone page** to open the mock phone flow in another browser tab. Allow the sample documents, select documents, and send them. Return to the kiosk, confirm, then use the existing preview, copies, colour/BW, pricing and payment screens. **Payment Done** simulates payment; printing is also simulated. No payment is charged and no printer is used.

The default loopback QR is for this computer. Scanning it on another device cannot reach this computer's loopback address. Real-phone testing requires the explicit HTTPS setup below. Mock mode has no credentials to enter and refuses production environments.

Stop with Ctrl+C. Ports 5081 (kiosk/feature service) and 5082 (mock provider) are separate from the working project's ports. Startup fails if a port is occupied; it does not stop another service.

## Configuration

The new, Git-ignored `digilocker-local/.env` contains only disabled/mock defaults. The existing `.gitignore` already ignores this filename, including nested directories. No existing environment file was changed. `.env.digilocker.example` documents every option; copy individual settings into the feature-local `.env` as needed. Process environment variables override that file. `--mock` overrides enabled/mode/preview for that process only.

Without `--mock`, `DIGILOCKER_ENABLED` defaults to `false`: no DigiLocker button, injected scripts or active DigiLocker routes. The original application's own launch remains completely unaffected by this module.

| Variable | Default / purpose |
| --- | --- |
| `DIGILOCKER_ENABLED` | `false`; exact `true` enables the feature |
| `DIGILOCKER_MODE` | `mock` or `live` |
| `DIGILOCKER_PORT`, `DIGILOCKER_MOCK_PORT` | `5081`, `5082`; loopback listeners |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:5081`; HTTPS origin for a real phone |
| `DIGILOCKER_REDIRECT_URI` | Public origin + `/digilocker/callback`; must exactly match registration |
| `DIGILOCKER_BASE_URL` | Official Meri Pehchaan provider origin |
| `DIGILOCKER_CLIENT_ID`, `DIGILOCKER_CLIENT_SECRET` | Required in live mode; mock generates ephemeral credentials |
| `DIGILOCKER_PURPOSE`, `DIGILOCKER_SERVICE_NAME` | Required authorization descriptions; letters/numbers/spaces/underscores |
| `DIGILOCKER_REQ_DOCTYPES` | Optional comma-separated types approved for the client |
| `DIGILOCKER_PAIR_TTL_MINUTES` | `5`; pairing/state validity |
| `DIGILOCKER_SESSION_TTL_MINUTES` | `10`; session and optional printer-file lifetime, maximum 30 |
| `DIGILOCKER_MAX_FILES` | `5`, maximum 10 |
| `DIGILOCKER_MAX_FILE_MB` | `10`, maximum 10 |
| `DIGILOCKER_MAX_MEMORY_MB` | `100`; document reservations across sessions |
| `DIGILOCKER_MAX_SESSIONS` | `20` |
| `DIGILOCKER_FRONTEND_DIR` | `frontend/dist`; relative to repository root or absolute |
| `DIGILOCKER_LOCAL_PREVIEW` | `true`; explicit simulated payment/printing, mock only |
| `DIGILOCKER_KIOSK_ID` | `LOCAL-KIOSK` in preview; an explicit local test kiosk ID is required otherwise |
| `DIGILOCKER_KIOSK_BACKEND_URL` | `http://127.0.0.1:5080`; used only outside preview |
| `DIGILOCKER_KIOSK_AGENT_URL` | `http://127.0.0.1:5079`; separate optional local printer |
| `DIGILOCKER_PRINTER_SOURCE` | Existing packaged Windows `printerAgent.js`, read only |
| `DIGILOCKER_MOCK_BASE_URL` | Loopback mock origin; usually leave unset |
| `DIGILOCKER_{AUTHORIZE,TOKEN,ISSUED,UPLOADED,FILE,REVOKE,LOGOUT}_URL` | Optional endpoint overrides, restricted to the configured provider origin |
| `NODE_ENV` | `production`/`prod` rejects mock mode |

Use `127.0.0.1` for the kiosk URL and the optional printer agent origin. The frontend directory must contain the existing `app.js`, `index.html`, assets and vendored PDF.js worker. The overlay is checked against `frontend/dist`, `dist`, and the packaged mini-PC frontend. It fails clearly if the required integration points have changed.

## Existing print flow integration

The response overlay registers the screen/button, wraps reset/file clearing and print completion, adds a transient-file marker to print requests, and explicitly selects preview mode. Mock preview replaces the demo's external payment QR with a local test-payment panel. No disk copy of the frontend is patched.

Received documents become neutral-named `File` records through the existing `createFileRecord`, `enforceUploadPageLimit`, `enforceUploadPaperSufficiency`, `readFileAsBase64` and `setJobFiles` helpers. They enter the normal preview at `state.step = 2`. Existing price calculation, copies, colour/BW and payment decisions remain in the original functions. The wrapper invokes the existing `startLocalPrintJob` implementation only after its payment flow reports success. It does not implement a new print engine or approve a real payment itself.

Real local printing additionally needs `run-printer.cjs --print`. This optional launcher reads and compiles the existing Windows agent in memory with a restricted, transient temp-file adapter. It reuses `printWithWindows` and `waitForWindowsPrintCompletion`. It binds loopback on a separate port, disables unrelated POST mutations and retry, avoids the original environment loader and startup registry changes, and accepts only marked DigiLocker submissions from the configured kiosk origin. Files are cleaned on success/failure and by a 60-second sweep. Startup cleanup runs only after acquiring its port, so a second launcher cannot clear the first launcher's jobs.

## Live local testing — not run during implementation

Live authorization and a tunnel require your explicit approval before an agent starts either. These are manual setup instructions, not a deployment:

1. Use a separately configured **local test backend** with its own local database and payment sandbox. The current project's root environment pointed to a remote database during discovery; do not use its ordinary startup command for this test without isolating that configuration separately. This module does not reconfigure or start it.
2. Obtain your approved DigiLocker Requester credentials and document types. In the Partner portal, register the **exact** HTTPS callback URL, including `/digilocker/callback`, with no extra slash/query. Configure only approved `req_doctype` values.
3. After authorizing a local tunnel, an already installed tool can forward to `http://127.0.0.1:5081`, for example `ngrok http http://127.0.0.1:5081` or `cloudflared tunnel --url http://127.0.0.1:5081`. No tunnel tool was installed or started here. Preserve the public Host header; do not configure a tunnel that disguises requests as the local kiosk host. Public hosts can reach phone routes, while kiosk bootstrap/status/files require the local boundary and kiosk secret.
4. Set the feature-local `.env` to `DIGILOCKER_ENABLED=true`, `DIGILOCKER_MODE=live`, `DIGILOCKER_LOCAL_PREVIEW=false`, the credentials, HTTPS `PUBLIC_BASE_URL`, matching `DIGILOCKER_REDIRECT_URI`, purpose/service name, explicit local test kiosk ID, and loopback backend/agent URLs. A changing tunnel URL requires an updated registration.
5. For an intentional physical printer test, start `node digilocker-local/run-printer.cjs --print`, then `node digilocker-local/start.cjs` in another terminal. Open the kiosk on `127.0.0.1:5081`; scan its HTTPS QR on the phone. Complete the existing payment sandbox flow before printing.
6. Test denial, expired QR, cancellation, multiple documents, print failure, and cleanup. Shut down the local processes and tunnel afterward.

The official [DigiLocker API directory](https://apisetu.gov.in/digilocker) now lists the [Requester Meri Pehchaan v2.4 specification](https://cdn.apisetu.gov.in/portal/assets/Requester-MeriPehchaan-APISpecificationv2.4.pdf), September 2026. Unlike the brief's v2.3 description, v2.4 requires both `purpose` and `service_name`. This implementation sends both. Authorization uses `openid`; uploaded files are listed only when the granted token scope includes `files.uploadeddocs`. No eAadhaar XML endpoint or identity extraction is used.

## Privacy and failure handling

- PKCE S256, one-use pairing/state, phone-cookie binding, CSRF, URI allowlists and constant-time HMAC checks are enforced. QR content never contains the kiosk secret. The phone never receives the token or client secret.
- Tokens and downloaded files stay in process memory. The token is revoked before READY, also on cancellation/failure/expiry. Provider errors are mapped to friendly messages without response bodies or identities in logs.
- PDF/JPG/PNG MIME and signatures, file size and image dimensions are checked. The existing vendored PDF.js parser verifies/counts PDFs in a time- and memory-limited worker; password-protected/invalid PDFs and documents over the existing 10-page limit are rejected.
- Buffer references are cleared and known buffers zeroed; browser blob URLs and print-content strings are released on completion, failure, reset, file clearing and page exit. Provider names are kept in the transient receipt; the normal job gets `Document-N` names. No document contents are stored in localStorage or a database by this feature.
- Abandoned sessions expire after the configured TTL and are swept every 60 seconds. If a browser disappears before cancellation reaches the service, TTL is the fallback. The optional agent stores files only under its own ACL-restricted OS-temp directory and removes recognized leftovers at startup.
- Revocation has two bounded attempts. A provider outage can prevent confirmed remote revocation; the flow fails closed and drops local tokens/files, with a phone logout prompt. Abrupt process termination cannot perform a remote revoke; provider expiry is the fallback. JavaScript/OS memory reclamation is not a forensic secure-erasure guarantee, and printer/spooler retention remains device-managed.
- Mock testing runs entirely on loopback; no live OAuth/document calls, production changes, dependency installs, or actual printing were performed.

## Checks

```powershell
node --test digilocker-local/test/core.test.cjs digilocker-local/test/integration.test.cjs digilocker-local/test/cleanup.test.cjs
node digilocker-local/test/browser.cjs
```

The browser test uses an already installed Chrome/Edge and the existing `ws` dependency; it downloads nothing and blocks non-loopback page requests. Set `DIGILOCKER_TEST_BROWSER` to an installed browser executable if necessary. It prints a unique temporary screenshot directory. Verification used Node 24.18.0, 23 passing automated tests, and the passing full browser flow. The pre-existing `test/digilocker.test.cjs` fails before and after with missing `../backend/digilocker/index.js`; that separate incomplete implementation was preserved.

## Rollback

Stop this module and keep `DIGILOCKER_ENABLED=false` without `--mock`. Launch the working kiosk as before. No existing source/config restoration is needed. The feature folder can be removed after saving anything you want from its ignored local `.env`. Local commits contain only this new folder. Do not use a hard reset or clean command: the workspace already contains your unrelated modified and untracked files.
