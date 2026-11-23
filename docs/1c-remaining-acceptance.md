# 1C remaining acceptance — 2026-11-14

## Stage 1 — actual timed retention cleanup: passed
- Database-only cleanup replaces the planned HTTP/Vault transport for this task. No HTTP secret or published deployment is needed; the signed external callback remains closed without SDF_CRON_SECRET.
- pg_cron installed through migration 0006. Named job `sdf-log-cleanup`, id 1, active, restored after acceptance to `0 * * * *` (24 executions/day). Nonces are normally removed within an hour after the 15-minute retention threshold; diagnostic logs within an hour after 30 days. Each table deletion is capped at 1000 rows/run; a backlog can take additional cycles.
- A real scheduler execution at **2026-11-14 01:31:00.110780 UTC** created receipt `9def21ab-5af3-4530-a4a6-cd150634865a` with nonce_count=1, log_count=1, client_count=1.
- Before execution: inserted distinctly labelled 31-day/29-day app and client logs, and 16-minute/14-minute nonces. After execution: expired rows absent, retained rows present. Recent real records untouched.
- Cleanup uses an empty search_path and schema-qualified objects, no authenticated execution grant. Its receipts have admin-only SELECT RLS. HMAC raw-byte verification remains covered by size, timestamp, signature mismatch, nonce-order and replay tests.
- No HTTP schedule was created, no credentials were copied to SQL, Vault or application source. External hooks are not activated or claimed accepted.

## Stage 2 — batch-1 seed and artifact viewer: passed
- Migrations 0007/0008 include literal seed inserts, so examples are not created on page load.
- Two apps: 澄远零售门店智能补货 (maintenance, v1.1), 门店巡检助手 (development). Both labelled source=seed, internal, pre-send redaction enabled.
- Six demo contacts and eight app-role associations; no fake auth users or profiles. Administrator ownership uses the already-verified account; demo contacts do not gain login permissions.
- Catalog reads back **33 block entries and 10 agent roles**. Every execution is “尚未实施”; no block is falsely available. B23/B25/B27/B28/B30 use identifier-only names because the supplied specification does not name them. Future rows are placeholders, not executable implementations.
- Six artifact versions: two Markdown constitution versions, JSON entity fragment, YAML OpenAPI fragment, Mermaid architecture, and inspection Markdown. Each displays “示例数据”. No future requirements, runs, feedback, tests or UAT records were seeded.
- UI verified Markdown, JSON, YAML, Mermaid rendering, v1/v2 switching, added-line diff, and YAML download/readback. Mermaid is dynamically imported and rendered in a script-disabled iframe with strict security; raw HTML is not executed by Markdown.
- Artifacts use the caller's database client and app membership/admin RLS. Anonymous reads denied; application visibility is checked before artifact querying. Catalog is authenticated read-only; no generic privileged query added.
- Desktop 1280×1800 and mobile 390×844 checked. Mobile document width equals viewport; multi-line application tabs use auto height.

## Stage 3 — real application call chain: passed for configured provider
- Administrator UI created a **standard primary** route to saved provider b158631f-b07a-4f58-809e-fa25deba4359 and database model `deepseek-flash`; existing provider/key/sensitivity settings were not changed. No unsupported tiers or fallback routes were invented.
- Selected retail app 1c000000-0000-4000-8000-000000000001; actual prompt “请只回复：应用调用链已连通。” returned “应用调用链已连通。”.
- Response: success, attempt=1, redacted=true, prompt_tokens=40, completion_tokens=53, total_tokens=93.
- Trace `t-1fb12a245e06f64c` matches a persisted app-scoped successful llm_calls row and `/api/admin/models/invoke` REQUEST_OK app_logs row. UI reload shows the same trace/call; no prompt or response is stored in call logs.
- This is **DeepSeek direct**, not LiteLLM-specific acceptance and not a workflow engine run. The lower-case requested alias deepseek-v4-flash was not substituted into the saved configuration or tested in this stage.

## Stage 4 — consolidated evidence
- All nine current self-check rows visibly pass, including encryption and each saved credential's decryptability, latest scheduled cleanup, catalog counts, artifacts and real app-call receipt.
- Workflow execution and external signed callbacks display “尚未实施”; none is counted as passed.
- Downloaded diagnostic JSON credential-pattern scan passed: no bearer token, JWT, sk-style key or encrypted v1 envelope; 67 app logs, 3 client logs, 16 model call rows in the checked export.
- Browser central flow reported zero uncaught page errors. Supervised build/typecheck is OK after correction of the optional title selection type.
- All **37 automated checks across 10 files passed**, including existing cryptography, redaction, model routing, signed cron, diagnostic permissions plus artifact difference, download filename, retention/grant contract and artifact-read permission tests.

## Remaining limitations
- Real LiteLLM acceptance requires a real LiteLLM configuration; current provider remains direct DeepSeek.
- External callback timeout/rate controls are deferred until batch 4 and required before activation; the existing HMAC callback is closed.
- This does not claim all original batch-1 historic checks (concurrent bootstrap/business portal/realtime foundation) or later workflow features have passed. Cleanup health is a recent execution receipt, not a direct scheduler-health probe; disabled scheduling becomes visibly stale after two hours.

## Follow-up acceptance — 2026-11-14, 01:50–01:53 UTC

### Passed in this follow-up
- Live administrator self-check: all nine current checks passed; external callbacks and workflow execution still show 尚未实施. The latest cleanup receipt remains the real 01:31 execution recorded above; no new scheduled execution was claimed or forced.
- Database inspection: one singleton row, CHECK(singleton = true), one bootstrap audit record, no public-schema CREATE for anon/authenticated. All public SECURITY DEFINER functions have empty search_path; bootstrap and cleanup deny anon/authenticated EXECUTE.
- Four simultaneous requests to the already-initialized bootstrap endpoint returned 410. This confirms closure only, not first-initialization concurrency. A focused Hono test also proves the actor comes from verified authentication rather than a supplied body user ID, and successful initialization writes an audit event.
- Administrator switched to the business view through the UI: /portal displayed applications without workbench navigation, then 返回工作台 restored /apps. This verifies administrator view switching, not a business-only account's restrictions.
- A deliberately nonexistent application in an invocation request returned NOT_FOUND with error `E-20261114-4a0d1f` and trace `t-51e4e24c39a9da88`. Searching that error in the log UI found its persisted interface log. No model was invoked for this rejection.
- Existing real successful model receipt `t-1fb12a245e06f64c` was read back through the API and log UI; its trace matches the `/api/admin/models/invoke` request log. Saved provider/model/route/key settings were unchanged; no additional paid model call was made.
- A newly downloaded diagnostic bundle passed the Bearer/JWT/sk-key/encrypted-envelope scan. Browser checks reported zero uncaught page errors; mobile document width stayed within 390 px. The old preview telemetry exception originates in a browser extension, not application code.
- The live public cron callback returned 403 without its configured secret. Automated HMAC tests still reject invalid raw-byte signatures, expired timestamps and replay before execution; the hosted signed callback remains deliberately inactive.
- Added the missing batch-1 live-refresh foundation: data-layer subscription cleanup, a caller-supplied query-key hook, 5-second polling before connection and after disconnect, and polling-only operation. Four focused tests cover the exact interval, connection transitions, setup failure and teardown. No workflow query, realtime publication or authorization policy was invented or activated.
- All **45 tests across 12 files passed**; supervised build reports OK. Screenshots and the raw diagnostic export were inspected in temporary browser staging; credentials are not included in this report.

### Remaining acceptance boundaries (not passed)
- First-ever concurrent bootstrap still requires a separate uninitialized database. The existing initialized database was not reset or weakened for this test.
- Business-only account enforcement was not tested in this follow-up; it needs an explicitly designated business-role account. Administrator view switching is not a substitute.
- Hosted realtime subscription/RLS acceptance belongs to batch 2 when a real run query and authorized event source exist; this follow-up verifies the reusable polling foundation only.
- Error-number correlation for a failed upstream model call was not recreated here: interface-error lookup and successful real model trace correlation were checked separately. Prior failure tests remain contract-provider evidence, not a newly verified real-provider failure.
- LiteLLM-specific acceptance still needs an actual LiteLLM service configuration. The current successful real provider is DeepSeek direct.
- Full “this batch and all prior checks passed” is therefore not claimed. The nine self-check rows are current health probes, not comprehensive historical acceptance evidence.

## Configured-service application call — 2026-11-14 01:57:59 UTC
- Result: **real application call passed for the currently saved provider; LiteLLM-specific acceptance remains pending**. Inspection found only `https://api.deepseek.com`, provider `deepseek-flash`, enabled, model array `[deepseek-flash]`; no separate LiteLLM gateway was configured. The UI's “LiteLLM / OpenAI compatible” category does not identify the implementation of the saved service.
- Used the existing standard primary route `e9d79120-adff-43dc-ae4d-09ce165c119d`, provider `b158631f-b07a-4f58-809e-fa25deba4359`, and retail example app `1c000000-0000-4000-8000-000000000001` through 管理 → 模型 → 调用链验收. No credentials, provider URL, model IDs, routes or sensitivity permissions were changed.
- Real prompt: “请只回复：应用调用链验收通过。”; actual response: “应用调用链验收通过。”. Model `deepseek-flash`, standard tier, attempt 1, redacted=true, prompt_tokens=40, completion_tokens=29, total_tokens=69, model duration=1240 ms.
- Trace `t-4101a8bf7214d44d`; persisted successful call `fdd18386-e7a7-4913-9e2a-22042c92fb87` at `2026-11-14T01:57:59.790359Z` includes the selected application/provider. Matching request log `e1252a5d-02d0-4b37-a03a-c27b94244019` records POST `/api/admin/models/invoke`, HTTP 200, REQUEST_OK at `2026-11-14T01:57:59.995815Z`.
- UI showed the real response; reloading the page retained the successful call, and the system log tab showed the same trace. Independent database readback confirmed both receipts. Browser reported zero uncaught errors.
- One real provider call was made and consumed the reported 69 tokens. Screenshots contain only the response and safe call/log metadata; credentials were not read, displayed or exported. This is not a workflow-engine run and does not test `deepseek-v4-flash` or a LiteLLM gateway.