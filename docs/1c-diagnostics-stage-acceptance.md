# 1C diagnostics — first stage, 2026-11-14

## Delivered and verified
- `app_logs` and `client_errors`: explicit grants, RLS enabled, authenticated SELECT restricted by `public.is_admin()`. Writes are narrow SystemOps methods.
- Server writes use a 1500 ms bound and one safe console fallback, without recursive logging. Payloads omit request bodies, headers, raw exception messages and prompts.
- Authenticated client reporting accepts only error category, safe path and bounded operation names. Signed-out errors stay in a bounded in-memory queue, with no anonymous writes.
- Admin endpoints: `/api/admin/logs`, `/api/admin/diagnostics`, `/api/admin/health`; client endpoint `/api/client-errors`.
- Admin self-check generated a controlled render error, preserved the workbench, returned an error number, recovered via the button, and found the persisted record by that number through the log UI.
- Downloaded diagnostic JSON passed the credential-pattern scan. Only allowlisted log/model metadata is exported; configuration and stored credentials are not queried for export.
- Desktop 1280×1800 and mobile 390×844 verified; mobile document width is 390 px, tables scroll within the page.
- Anonymous client reporting returned 401; non-admin diagnostic endpoints are covered by focused Hono permission tests.

## Scheduler safety foundation
- Actual database check: Vault and pgcrypto installed; pg_cron and pg_net listed as available but not installed. No active job is claimed.
- Raw-byte HMAC uses timestamp + literal `\n` + nonce + literal `\n` + lowercase SHA256 body digest.
- Tests cover the 4096-byte bound, 300-second timestamp window, exact body bytes, nonce-before-execution, and replay denial.
- `cron_nonces` is service-only; restricted cleanup removes nonces older than 15 minutes and diagnostic logs older than 30 days.
- The public cron endpoint rejects requests while `SDF_CRON_SECRET` is absent. External scheduler activation, complete public-hook rate/timeout safeguards and hosted verification are still pending; do not activate until those safeguards pass.

## Not complete
- Full 1C seed/catalog/artifact viewer stage.
- Real app-task model routing and LiteLLM-specific verification; prior real connection verification was DeepSeek direct.
- Full prior-batch self-check coverage and per-credential decryption checks.
- This is staged delivery, not a claim that all batch 1C checks have passed.