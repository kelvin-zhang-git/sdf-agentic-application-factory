# 1A acceptance
- [x] Verify application and contact isolation with the second registered account.
- [x] Verify application create/update and member add/remove audit records through the UI.
- [x] Record acceptance results and preserve clearly labelled evidence in docs/1a-permission-audit-acceptance.md.

# 1B models and server
- [x] Configure the user-backed SDF_SECRET_KEY and verify its Base64/32-byte format through a real encryption request.
- [x] Add encrypted secrets, LiteLLM providers, three-tier model routes, and model-call records with admin-only RLS.
- [x] Implement AES-GCM, provider CRUD, connection testing, model selection, sensitive-data checks, redaction, and usage recording.
- [x] Build the admin model configuration UI without exposing plaintext keys.
- [x] Run crypto/routing/permission tests and browser checks; record results in docs/1b-model-acceptance.md.
- [x] Diagnose the user's real-provider connection failure; discover database model IDs and verify DeepSeek direct connection with a real OK response and persisted usage.
- [x] Complete real app-routed invocation acceptance using the configured DeepSeek direct provider and a persisted standard route.
- [ ] Complete LiteLLM-specific acceptance; blocked on a real LiteLLM service configuration, not supplied by the current direct provider.

# 1C diagnostics — staged delivery
- [x] Implement authenticated client-error reporting and bounded non-recursive server logging.
- [x] Add admin log search, safe diagnostic export, and recoverable rendering-error self-check.
- [x] Verify admin-only access, error correlation, redaction, and desktop/mobile behavior for the delivered diagnostic stage.
- [x] Check scheduler availability and install pg_cron for SQL-only cleanup; preserve raw-byte HMAC verification and replay-protected adapter without activating HTTP callbacks.
- [x] Activate and verify SQL-only hourly log cleanup; HTTP scheduling is unnecessary for this database-only task.
- External public hooks remain disabled and deferred to batch 4; timeout/rate safeguards are mandatory before their activation.
- [x] Add batch-1-only seed assets and artifact viewer; keep future features visibly unimplemented.

# Remaining 1C acceptance
- [x] Verify actual timed database cleanup and retention boundaries; preserve HMAC rejection checks.
- [x] Deliver batch-1 example catalogs, two example apps/contacts and safe artifact viewing.
- [x] Verify the configured real model through an application route and persisted call record.
- [x] Record stage-by-stage evidence and remaining limitations without claiming later batches passed.

# 1C follow-up acceptance
- [x] Recheck live self-check, interface-error lookup/successful model trace correlation, diagnostic export and administrator portal switching.
- [x] Add missing batch-1 realtime/polling foundation and focused tests without claiming workflow execution.
- [x] Verify initialized bootstrap denial, schema privileges and public cron rejection through focused tests and live checks.
- [x] Update acceptance records with current evidence and explicit limits on initial-bootstrap concurrency and LiteLLM.
- [ ] First-initialization concurrency acceptance: requires a separate uninitialized database; do not reset existing initialization.
- [ ] Business-only account acceptance: requires a user-designated account for the business role; administrator view switching alone is insufficient.
- Hosted realtime/RLS acceptance remains in batch 2; external hook activation and its timeout/rate controls remain in batch 4.

# Configured-service application call acceptance
- [x] Inspect saved service/routes, execute one real app call through the administrator UI, and read back its persisted trace.
- [x] Append actual provider identity, response, usage and limitations to the acceptance records without changing credentials or model IDs.
- Current saved service is still DeepSeek direct; the existing LiteLLM-specific acceptance blocker remains unchanged.

# Priority: real LiteLLM deepseek-v4-flash acceptance
- [ ] Configure a real LiteLLM gateway and exact model alias deepseek-v4-flash, then verify app invocation and persisted receipts; blocked until a reachable LiteLLM URL and its gateway credential are supplied securely.
- [ ] Add actual LiteLLM results to acceptance records after successful verification; do not substitute DeepSeek direct or another model alias.
- Batch 2 implementation is paused until this requested专项验收 is resolved.

# Batch 2 (plan v2 approved; LiteLLM no longer blocks batch 2)
- [x] 2A: schema, constraints, RLS, storage bucket/policies, integrity triggers, SDF_CRON_SECRET configured; 11 rolled-back DB checks passed.
- [x] 2B: ModelGateway (openai_compatible), engine RPCs (claim/lease/merge/decide/retry/skip/cancel/rerun), engine-tick hook + schedule, integration tests for concurrency/lease/chunk idempotency.
- [x] 2C: blocks B01–B04, B08 and requirement_only v1.0.0 (three weights).
- [x] 2D: run detail, run list, workflows page (no copy), inbox, requirements tab.
- [x] 2E: full acceptance matrix; BA and non-member test accounts.
- [x] Published timer-only acceptance: R-0003 advanced solely through managed 5-minute ticks and completed at 04:10 UTC; published UI confirmed all four steps, and the route reported `runtime` background keep-alive.
- [ ] Later: switching to LiteLLM requires no block/workflow code change (blocked on a LiteLLM deployment).
