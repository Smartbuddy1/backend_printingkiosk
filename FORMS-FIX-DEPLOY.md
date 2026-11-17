# Kiosk-specific forms fix

Ordinary services now retain explicit kiosk assignments after restart. Super
Admin kiosk edits use `PUT /api/super-admin/kiosk-services/:kiosk/:service`:
shared services are copied for the selected kiosk. DELETE on the same route
excludes that kiosk and preserves other assignments and document files.

Existing service and template writes require `X-Kiosk-Config-Version` from the
loaded snapshot. Missing/stale versions return 428/409. Upgrade the frontend
together with this backend; old editor pages must reload before saving.

Before each service write, a private `.service-history` snapshot is created next
to DATA_PATH. Provision writable, persistent storage there and retain it with
regular backups. Failed backup/persistence refuses the mutation. Unrelated
PostgreSQL saves no longer replace the forms catalogue. Kiosk Admin remains
read-only for service setup.

Validated on 17 November 2026 in a separate PostgreSQL database and restricted
staging role: two kiosks on the same project, shared/private edits, scoped remove,
concurrent/stale saves, template CRUD, restart persistence, actual denied-table
write rollback and history-write failure refusal. No production data was used
in these staging fixtures. Live deployment has one backend process; multi-process
writers need database-level concurrency coordination before scaling this design.

Recovery must use a fresh snapshot and additive kiosk-specific request. Never
replace the full database from an old forms backup. Preserve current jobs,
payments, other kiosks and existing forms. Keep backups and recovery payloads
outside this repository.
