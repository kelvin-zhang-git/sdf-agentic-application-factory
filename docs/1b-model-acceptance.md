# 1B model configuration acceptance — 2026-11-14

## Scope and result
Implemented and exercised model configuration, AES-GCM credential storage, OpenAI-compatible calls, three-tier routing, fallback, sensitive-data restrictions, PII redaction, usage records, and admin-only access. The live HTTP checks used a clearly labelled temporary OpenAI-compatible contract service, not a real LiteLLM deployment. Real LiteLLM acceptance remains pending the user's service details.

## Secret key configuration
- `SDF_SECRET_KEY` is stored through Lovable's secure secret form and is never read by browser code or returned by an API.
- Runtime validation requires canonical Base64 decoding to exactly 32 bytes (`^[A-Za-z0-9+/]{43}=$`). The final saved value passed a real encryption request.
- The user retains the original value for backup and future local deployment. No key value is present in source, tests, logs, or this report.

## Database and access control
Migration `0003_sdf_1b_model_configuration.sql` created:
- `secrets`: ciphertext, last four characters, kind and ownership metadata. RLS enabled with no user policies; only `service_role` has a grant.
- `llm_providers`: base URL, database-backed model ID array, secret reference, sensitive-data permission, enabled flag, priority and last test state. Admin-only RLS for all operations.
- `model_routes`: `fast` / `standard` / `deep`, provider, model ID and unique fallback order. Admin-only RLS for all operations.
- `llm_calls`: trace, app/provider/model, result, duration, token usage, attempt, redaction flag and sanitized error. Admin-only SELECT; writes only through the privileged system operation.

Database inspection confirmed RLS on all four tables, no policy on `secrets`, valid `v1:` ciphertext, and absence of the contract API key plaintext.

## API surface
All routes require a verified user token; model routes additionally require the server-side admin check.
- `GET /api/admin/models`
- `POST /api/admin/models/providers`
- `PATCH /api/admin/models/providers/:id`
- `DELETE /api/admin/models/providers/:id`
- `POST /api/admin/models/providers/:id/discover`
- `POST /api/admin/models/providers/:id/test`
- `POST /api/admin/models/routes`
- `PATCH /api/admin/models/routes/:id`
- `DELETE /api/admin/models/routes/:id`
- `POST /api/admin/models/invoke`
- `GET /api/admin/models/calls`

Model calls use only `<database base_url>/chat/completions`; model discovery uses `<database base_url>/models`. Model IDs are validated against the provider's database array. No vendor SDK or Lovable AI Gateway is used.

## Cryptography
- A new provider generates its secret UUID before encryption.
- AES-GCM uses a fresh 12-byte IV and 128-bit tag for every write.
- AAD is exactly `sdf-secret:v1:<secret_id>:<kind>`.
- Envelope is `v1:<key_id>:<base64 iv>:<base64 ciphertext+tag>`.
- `key_id` is the first 16 lowercase hex characters of SHA-256(key bytes).
- Reconfiguration overwrites ciphertext with a new IV and writes `model.secret_rotated` audit. APIs expose only the last four characters.

## Live checks
- PASS: provider creation through the admin UI; only a masked key was displayed.
- PASS: OpenAI-compatible connection test returned success and 12 total tokens from the contract service.
- PASS: route order 1 returned HTTP 500; invocation automatically used route order 2 and returned `attempt = 2`.
- PASS: model ID in the outbound request matched the database route.
- PASS: bad address returned Chinese `LLM_UNAVAILABLE` with an error number; failure status refreshed immediately after the UI fix.
- PASS: a sensitive app with no authorized provider returned HTTP 400 `LLM_SENSITIVE_FORBIDDEN` before any model call.
- PASS: an app with pre-send redaction enabled replaced phone, PRC ID, email and bank card values; the contract response contained all four redaction labels and none of the originals.
- PASS: second account with no global roles received HTTP 403 `FORBIDDEN` for model configuration reads, call reads and provider writes; the admin UI was unavailable.
- PASS: provider create/update/route/delete audit events were persisted without credentials.
- PASS: temporary provider, routes and secret were deleted afterward; counts are zero. Eight contract call records and the labelled `1B模型安全验收（契约）` app remain as evidence.

## Automated checks
- 17/17 tests passed across four test files.
- AES-GCM round trip, envelope/fingerprint format, random IV, wrong-key and wrong-AAD rejection, and exact 32-byte key validation passed.
- Fallback ordering, sensitive/confidential restrictions, no unauthorized fallback, PII redaction, database model ID use, usage parsing and bad-address mapping passed.
- Existing routing and redaction regressions passed.
- Latest application build/typecheck: OK. Browser checks reported no page errors.

## Still pending
- LiteLLM-specific acceptance remains pending: the user's configured URL is `https://api.deepseek.com` (DeepSeek direct), not a LiteLLM deployment.
- App-routed invocation is now verified: a standard primary route was configured through the administrator UI using the saved `deepseek-flash` model ID. The retail example app returned “应用调用链已连通。” with 93 tokens, `attempt=1`, `redacted=true`, trace `t-1fb12a245e06f64c`; its app-scoped call record and matching request log persisted and were visible after reload.
- Batch 1C diagnostic and example checks are recorded in docs/1c-remaining-acceptance.md.

## Real-provider connection diagnosis — 2026-11-14
- Original connection test used database model ID `Deepseek-v4-flash` and returned HTTP 400 from the provider.
- Admin UI **获取模型列表** succeeded; provider returned `deepseek-flash` and `deepseek-v4-pro`, which were saved through the existing authenticated discovery endpoint. The original ID was absent from the returned list.
- Admin UI **测试连接** then used the first database model ID `deepseek-flash`: `ok=true`, reply `OK`, duration 1422 ms, 34 prompt tokens + 11 completion tokens = 45 total tokens.
- UI readback showed **连接成功** and a successful persisted call record. No key was read, replaced or included in this report; provider URL and sensitivity authorization were unchanged.
- This verifies a real DeepSeek direct connection only, not LiteLLM or app task-route invocation.

## Configured-service application call recheck — 2026-11-14 01:57:59 UTC
- Saved configuration still contains only DeepSeek direct (`https://api.deepseek.com`, `deepseek-flash`); no LiteLLM gateway was found. Configuration and credentials were not changed.
- Existing standard primary route and retail example app were selected through the administrator UI. A real prompt returned “应用调用链验收通过。”, attempt=1, redacted=true, 40 prompt + 29 completion = 69 tokens, 1240 ms.
- Trace `t-4101a8bf7214d44d` was persisted in the successful app-scoped call and matching HTTP 200 REQUEST_OK interface log; both read back through the UI after reload and independently through the database.
- Real app-call acceptance passed for this saved provider. LiteLLM-specific acceptance remains blocked on an actual LiteLLM gateway configuration; detailed receipts are recorded in docs/1c-remaining-acceptance.md.
