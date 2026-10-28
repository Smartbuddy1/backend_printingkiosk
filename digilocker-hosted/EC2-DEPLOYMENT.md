# EC2 deployment for the live DigiLocker service

This deploys the real-provider service in **disabled** mode while DigiLocker
approval and client credentials are pending. No mock provider is started. Do not
set `DIGILOCKER_ENABLED=true` until API Setu has issued credentials and approved
the exact callback and requested scopes.

## Pull the backend branch

Run this in the existing backend repository on the API EC2. Check `git status`
first and preserve any local changes. Do not reset the checkout.

```sh
git fetch origin
git switch --track origin/feature/digilocker-service-dev11
```

If the branch is already checked out, use `git pull --ff-only`.

## Configure the service

Create `/etc/printing-kiosk/digilocker.env` with owner-only permissions. Use the
production API origin and frontend origin below; do not add a path to
`PUBLIC_BASE_URL` or `DIGILOCKER_ALLOWED_ORIGINS`.

```ini
NODE_ENV=production
DIGILOCKER_MODE=live
DIGILOCKER_ENABLED=false
DIGILOCKER_PORT=5091
PUBLIC_BASE_URL=https://api.theaaryatechnologies.com
DIGILOCKER_REDIRECT_URI=https://api.theaaryatechnologies.com/digilocker/callback
DIGILOCKER_ALLOWED_ORIGINS=https://aaryainnovtech.com
DIGILOCKER_BASE_URL=https://digilocker.meripehchaan.gov.in
DIGILOCKER_CLIENT_ID=
DIGILOCKER_CLIENT_SECRET=
DIGILOCKER_KIOSK_BACKEND_URL=http://127.0.0.1:5080
DIGILOCKER_PURPOSE=Print selected documents at kiosk
DIGILOCKER_SERVICE_NAME=Printing Kiosk
DIGILOCKER_REQ_DOCTYPES=
```

Keep the environment file out of Git and deployment archives. Install
`printing-kiosk-digilocker.service.example` as a systemd unit after replacing
both `/ABSOLUTE/PATH/TO/backend_printingkiosk` paths with the actual backend
checkout path. Confirm the Node path with `command -v node`. Then run
`systemctl daemon-reload`, enable and start `printing-kiosk-digilocker`, and check
its journal. The service listens on `127.0.0.1:5091`; do not open that port in the
EC2 security group.

## Configure the HTTPS proxy

Add the locations from `nginx.locations.example` inside the existing HTTPS
server block for `api.theaaryatechnologies.com`. They proxy only DigiLocker routes
to the dedicated service and disable URL access logs for authorization data.
Run `nginx -t` before reloading Nginx.

With credentials still unset, `GET /digilocker/health` should report `ready:false`
and the callback page should say activation is pending. This confirms routing only;
it does not confirm partner approval or OAuth access.

## Build and assign the frontend service

On the separate frontend EC2, use branch
`feature/digilocker-service-dev11`, then build the existing static frontend with:

```sh
FRONTEND_DIGILOCKER_ENABLED=true \
FRONTEND_BACKEND_URL=https://api.theaaryatechnologies.com \
FRONTEND_PUBLIC_URL=https://aaryainnovtech.com/printingkiosk/ \
npm run build
```

Publish the resulting `dist` using the existing frontend procedure. In Super Admin,
add a DigiLocker service to each intended kiosk and set Enabled. This controls the
customer service card and the backend's per-kiosk policy check. Other service
assignments and print options are unchanged.

The card can be enabled before provider credentials are supplied; attempts will
show the real service's unavailable response. Real authorization/document access
must wait until approved credentials, callback registration and scopes are
configured. No provider credentials are part of this branch.
