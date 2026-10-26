# Local implementation walkthrough

## Result

The local DigiLocker button opens a QR, countdown and four-step progress screen in the existing kiosk theme. English, Hindi and Marathi strings are included. Phone consent/selection delivers verified documents to the existing preview, page limit, paper checks, copies, colour/BW, pricing, payment and print functions. Completion and cancellation clear the feature's documents and session.

Run `node digilocker-local/start.cjs --mock` from the repository root, then open `http://127.0.0.1:5081`. Use **Open phone page** for the loopback mock. The preview prominently labels simulated payment/printing. See [README_DIGILOCKER.md](README_DIGILOCKER.md) for configuration, live-phone setup and rollback.

## Scope and preservation

Work stays on `feature/digilocker-local`, based on `0240e7f`, with local commits only. The user's later instruction to preserve all current changes and continue superseded the original dirty-worktree stop. No existing file was edited, staged or committed by this implementation; all additions are inside `digilocker-local/`.

The initial discovery plan was recorded at `%TEMP%/digilocker-plan-20261007-0240e7f/IMPLEMENTATION_PLAN.md`. Following the later no-existing-changes instruction, the integration was adapted to read-only response overlays. The exact current integration changes can be reviewed in `integration/overlay.cjs` and `integration/agent-overlay.cjs`. They apply only to this optional local process, never the source files on disk.

SHA-256 verification against `%TEMP%/digilocker-preserved-20261007/baseline.json` passed for all nine files: root `server.js`, `package-lock.json`, `package.json`, `.gitignore`, `load-env.js`, `frontend/dist/app.js`, `frontend/dist/index.html`, `dist/app.js`, and the packaged `local-agent/printerAgent.js`.

The workspace already had modified `server.js` and `package-lock.json` and many untracked project folders. Those remain intact. `git diff --stat 0240e7f` includes those pre-existing changes; use `git diff --stat 0240e7f HEAD -- digilocker-local` to isolate these commits. No dependency or lockfile change belongs to this feature.

## Files added

| Group | Files / role |
| --- | --- |
| Startup/config | `start.cjs`, `config.cjs`, `.env.digilocker.example`; separate loopback service, default-off flag and explicit local configuration |
| OAuth/state | `server.cjs`, `security.cjs`, `sessions.cjs`, `provider.cjs`; routes, PKCE, HMAC, ownership, revocation and cleanup |
| Document validation | `documents.cjs`, `pdf-worker.cjs`; bounded downloads and existing PDF.js page counting |
| UI | `i18n.cjs`, `phone-pages.cjs`, `public/kiosk.js`, `public/kiosk.css`, `public/phone.js`, `public/phone.css` |
| Local mock | `mock/server.cjs`, `mock/pdf.cjs`; generated sample PDFs, consent, real PKCE checks/HMAC, revoke |
| Integration | `integration/overlay.cjs`, `integration/agent-overlay.cjs`, `integration/transient-files.cjs`, `run-printer.cjs`; reuse of current UI and optional original Windows printing code |
| Verification | `test/core.test.cjs`, `test/integration.test.cjs`, `test/cleanup.test.cjs`, `test/flow.cjs`, `test/browser.cjs` |
| Documentation | `README_DIGILOCKER.md`, this walkthrough |

Implementation/test commit `2f50ac9`: **26 new files, 1,536 insertions, zero existing files changed**. Documentation adds two new files. The feature-local `.env` is an additional ignored file containing disabled/mock defaults, no credentials; `git check-ignore digilocker-local/.env` verified exclusion.

## Verification

- **23/23 tests passed** with the explicit module test command in the README: RFC 7636 PKCE vector, HMAC rejection, state binding/single use/expiry, status transitions, limits, real PDF parsing, source preservation, full HTTP mock, phone/session authorization, URI allowlists, denied consent, malformed callback cleanup, revocation failure, download cancellation, flag-off behavior, loopback boundary and transient printer-file deletion.
- **Browser E2E passed** in installed headless Chrome: Services button, mock consent, unselected document checkboxes, two PDFs/three pages, existing colour/copies pricing, payment required before printing, simulated print completion, document deletion, exit from normal preview, Hindi/Marathi screens, and reset/idle entry. No unhandled browser exceptions. The test disallows external page requests.
- Screenshots from the final run: `%TEMP%/digilocker-browser-mJsHI1/artifacts` (Services, QR, phone selection, received documents, existing payment, completion).
- Browser verification found and fixed CSP redirect handling in mock consent and the phone form's Origin header policy. These issues were invisible to direct HTTP tests.
- Root server and new entry-point syntax checks passed. All nine original-file baseline hashes matched after implementation.
- The pre-existing `node --test test/digilocker.test.cjs` failed both before and after: `MODULE_NOT_FOUND: ../backend/digilocker/index.js`. Its separate unfinished module and root-server references were preserved. The project has no standard `npm test` script.

## Assumptions and remaining validation

The default UI copy is `frontend/dist`; the launcher can read the other existing copies through `DIGILOCKER_FRONTEND_DIR`. It requires the already installed `qrcode` and `ws` packages and existing PDF.js worker, with no installs/upgrades. Verification used Node 24.18.0.

Official Requester v2.4 requires `purpose` and `service_name`; the implementation follows that change from the brief. The README links the official specification. Partner credentials, redirect registration and approved document types remain deployment-specific configuration, not guessed values.

Real DigiLocker authorization, tunnels, real payments and physical printer operation were **not** exercised. The optional physical-print adapter was checked by syntax/source assertions and actual temporary-file cleanup tests. A full live run needs explicit approval, registered credentials, an isolated local test backend/payment sandbox, and a local printer. No existing backend was started because its environment referenced a remote database.

Provider revocation cannot be guaranteed through a provider outage or a killed process. Browser disappearance uses the server TTL fallback; physical spooler/printer retention is controlled by that device. Source overlays deliberately fail closed when expected integration points change, so future upstream UI/agent changes may require updating this new adapter.

Rollback is stopping the local process and leaving its flag off; the working project's original files need no restoration. Never hard-reset or clean this shared dirty workspace to remove the feature.
