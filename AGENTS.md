## 本地运行（vm-9 原生 PostgreSQL）

- 数据库在 `vm-9` 的 PostgreSQL 16，不使用 Supabase。迁移仍放在 `drizzle/migrations`，由 `deploy/vm9` 的脚本灌入。
- 模型调用只走已配置的网关地址，不要在代码里写死厂商域名或密钥。
- 不要把 `.env.local`、`/root/.sdf-secrets` 或 API Key 提交进仓库。
- `main` 仍对应 Lovable 同步历史，本地改造放在 `local-main`，不要强推 `main`。

## SDF architecture rules
- Server code is layered: `src/core` (pure TS, Web APIs only, no database driver imports), `src/api` (Hono app, routes, middleware; deps injected), `src/adapters` (PostgreSQL, files, scheduler, env). Why: migration reuses core + Hono and swaps adapters only.
- `/api/*` business queries use `ctx.db` created for the verified user so RLS applies; the service connection is reachable only through `SystemOps` methods and the engine store. Why: least privilege; never add a generic admin query method.
- Components never open the database; they call `src/data/*` (auth.ts, http.ts, sdf.ts, realtime.ts). Why: the browser only sees REST and SSE.
- All SECURITY DEFINER SQL functions use `SET search_path = ''` and schema-qualified names; permission checks live in `is_admin()` / `has_app_role()` / helpers. Why: injection safety and single migration point.
- Every API error returns `{error:{code,message,error_id,trace_id}}` via the Hono onError; log payloads pass through `core/redact.ts`. Why: traceable diagnostics without leaking secrets.
- Unimplemented features render the `Planned` notice and are listed in `core/meta.ts` as not_started/schema_only, never fake data.
- Route loading failures use a shared recoverable error view; reset failed query state before retrying so transient network failures do not replace the workbench with a crash screen.
- Diagnostic log writes are bounded by safeLog and use allowlisted metadata, never raw request bodies, headers or exception messages; this prevents recursive failures and credential leakage.
- Time-based log retention runs wholly in PostgreSQL with bounded deletes and admin-readable execution receipts; no HTTP credential is needed for database-only work.
- Example catalogs remain non-executable, and example artifacts use app-scoped RLS; Markdown excludes raw HTML and Mermaid renders in a script-disabled sandbox so examples never imply implemented workflows.
- Live refresh uses a data-layer controller plus an opt-in private data-free subscription; useLiveRun invalidates caller-supplied query keys and polls on disconnect. Why: preserve API/RLS boundaries without inventing workflow endpoints or enabling unpublished realtime policies.
- Workflow engine state lives only in workflow_runs/step_runs; users read via RLS and every engine, requirement, version and artifact write goes through server-only SECURITY DEFINER RPCs with audit. Why: atomic claims, attempt history and forced versioning.
- Long block work runs as ≤20s idempotent chunks keyed by (step_run_id, attempt, cursor_seq) and merged in one RPC transaction; pages never drive execution. Why: Workers have no long background runtime.
- Deferred server work registers with ctx.waitUntil or the runtime waitUntil, and claims prefer fresh steps while capping expired-lease reclaims at 3. Why: Workers stop after the response, and one stuck step must not starve the queue.
