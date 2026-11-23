// Hono application = the platform REST API. Runtime-agnostic: deps are injected by the entry.
import { Hono } from "hono";
import { AppError } from "@/core/errors";
import type { AppEnv, Deps } from "./context";
import { traceMw, bodyLimitMw, authMw, onError } from "./middleware";
import { coreRoutes } from "./routes/core";
import { appRoutes } from "./routes/apps";
import { modelRoutes } from "./routes/models";
import { diagnosticRoutes } from "./routes/diagnostics";
import { cronRoutes } from "./routes/cron";
import { exampleRoutes } from "./routes/examples";
import { runRoutes } from "./routes/runs";
import { requirementRoutes } from "./routes/requirements";
import { authRoutes } from "./routes/auth";
import { eventRoutes } from "./routes/events";
import { designRoutes } from "./routes/design-tasks-docs";
import { connectorRoutes } from "./routes/connectors";
import { evolutionRoutes } from "./routes/evolution";
import { stage4Routes } from "./routes/stage4";
import { adminDashboardRoutes } from "./routes/admin-dashboard";
import { templateRoutes } from "./routes/document-templates";
import { oemRoutes } from "./routes/oem";
import { mcpRoutes } from "./routes/mcp";

export function createApi(deps: Deps) {
  const api = new Hono<AppEnv>().basePath("/api");
  api.use("*", traceMw(deps));
  api.onError(onError);
  api.notFound(() => { throw new AppError("NOT_FOUND", "接口不存在"); });
  api.use("*", (c, next) => bodyLimitMw(c.req.path.endsWith("/ingest/reports") ? 16 * 1024 * 1024 : /^\/api\/apps\/[^/]+\/sources$/.test(c.req.path) ? 11 * 1024 * 1024 : 1024 * 1024)(c, next));
  // /api/public/* is the hooks surface (batch 4/1C): same trace/error/limits, no user login.
  api.use("*", async (c, next) => (c.req.path.startsWith("/api/public/") ? next() : authMw(c, next)));
  api.route("/", coreRoutes);
  api.route("/admin/models", modelRoutes);
  api.route("/apps", appRoutes);
  api.route("/", diagnosticRoutes);
  api.route("/", exampleRoutes);
  api.route("/", runRoutes);
  api.route("/", requirementRoutes);
  api.route("/public/hooks", cronRoutes);
  api.route("/public/auth", authRoutes);
  api.route("/", eventRoutes);
  api.route("/", designRoutes);
  api.route("/", connectorRoutes);
  api.route("/", evolutionRoutes);
  api.route("/", stage4Routes);
  api.route("/", adminDashboardRoutes);
  api.route("/", templateRoutes);
  api.route("/", oemRoutes);
  api.route("/", mcpRoutes);
  api.post("/auth/logout", async (c) => {
    await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), action: "auth.logout", target_type: "user", target_id: c.get("userId") });
    return c.json({ ok: true });
  });
  return api;
}

export const ROUTE_LIST = [
  "GET /api/me", "PATCH /api/me", "GET /api/tokens", "POST /api/tokens", "POST /api/tokens/:id/revoke", "POST /api/bootstrap", "GET /api/meta (admin)", "GET /api/audit",
  "GET /api/admin/users (admin)", "PUT /api/admin/users/:id/roles (admin)",
  "GET /api/apps", "POST /api/apps", "GET /api/apps/:id", "PATCH /api/apps/:id",
  "GET /api/apps/:id/members", "POST /api/apps/:id/members", "DELETE /api/apps/:id/members/:mid",
  "GET /api/apps/:id/directory (lead/admin)", "PUT /api/apps/:id/members/by-user/:uid (lead/admin)",
  "GET /api/apps/:id/contacts", "POST /api/apps/:id/contacts", "DELETE /api/apps/:id/contacts/:acid",
  "POST /api/apps/:id/contacts/:acid/link",
  "GET /api/admin/models (admin)", "POST /api/admin/models/providers (admin)",
  "PATCH /api/admin/models/providers/:id (admin)", "DELETE /api/admin/models/providers/:id (admin)",
  "POST /api/admin/models/providers/:id/discover (admin)", "POST /api/admin/models/providers/:id/test (admin)",
  "POST /api/admin/models/routes (admin)", "PATCH /api/admin/models/routes/:id (admin)",
  "DELETE /api/admin/models/routes/:id (admin)", "POST /api/admin/models/invoke (admin)",
  "GET /api/admin/models/calls (admin)",
  "POST /api/client-errors (authenticated)", "GET /api/admin/logs (admin)",
  "GET /api/admin/diagnostics (admin)", "GET /api/admin/health (admin)", "GET /api/admin/dashboard (admin)",
  "GET /api/catalog (authenticated)", "PATCH /api/catalog/:id (admin)", "GET /api/apps/:id/artifacts (member/admin)",
  "GET /api/workflows", "POST /api/apps/:id/runs (lead/ba/admin)", "GET /api/apps/:id/runs", "GET /api/runs/:id",
  "POST /api/runs/:id/cancel (lead/starter)", "POST /api/runs/:id/rerun (lead/starter)", "POST /api/steps/:id/decide (checkpoint role/lead)",
  "POST /api/steps/:id/retry", "POST /api/steps/:id/skip (lead)", "GET /api/inbox",
  "GET|POST /api/apps/:id/sources (POST lead/ba)", "GET /api/sources/:sid", "GET /api/apps/:id/requirements", "GET /api/requirements/:rid/versions",
  "POST /api/requirements/:rid/edit (lead/ba)", "GET /api/apps/:id/findings", "PATCH /api/findings/:fid (lead/ba)",
  "GET /api/apps/:id/questions", "PATCH /api/questions/:qid (lead/ba)", "POST /api/apps/:id/questions/apply (lead/ba)",
  "GET|PUT /api/apps/:id/constitution", "POST /api/apps/:id/constitution/draft", "POST /api/public/hooks/engine-tick (HMAC or managed scheduler)",
  "POST /api/public/auth/signup", "POST /api/public/auth/login", "POST /api/auth/logout", "GET /api/events", "GET /api/sources/:sid/download",
  "GET|PUT /api/apps/:id/data-model", "GET /api/apps/:id/data-model/schema.sql", "GET /api/apps/:id/openapi.yaml",
  "GET /api/apps/:id/prototype", "POST /api/apps/:id/prototype/comments", "POST /api/apps/:id/prototype/revise",
  "GET /api/apps/:id/tasks", "GET /api/apps/:id/tasks/:code/context", "PATCH /api/tasks/:taskId",
  "GET /api/apps/:id/test-cases", "GET /api/apps/:id/documents", "GET /api/artifacts/:id/export.docx",
  "GET|POST /api/admin/document-templates (admin)", "PATCH /api/admin/document-templates/:id (admin)",
  "POST /api/admin/document-templates/:id/versions (admin)", "GET /api/admin/document-templates/:id/preview.docx (admin)",
  "GET /api/connectors", "POST /api/connectors", "POST /api/connectors/:id/test", "GET /api/apps/:id/connectors",
  "POST /api/apps/:id/merge-requests/:id/bind", "POST /api/apps/:id/merge-requests/:id/accept (lead/qa)", "POST /api/apps/:id/merge-requests/sync",
  "POST /api/apps/:id/ingest-tokens", "POST /api/apps/:id/reports (lead/qa)", "GET /api/apps/:id/flow-metrics", "GET /api/apps/:id/gates", "POST /api/apps/:id/gates/run", "POST /api/apps/:id/gates/waive",
  "POST /api/public/hooks/scm/:id", "POST /api/public/hooks/ingest/reports",
  "GET|POST /api/apps/:id/feedback", "GET|POST /api/apps/:id/changes", "POST /api/apps/:id/changes/:crId/confirm",
  "GET /api/apps/:id/uat", "POST /api/uat/:itemId", "GET /api/apps/:id/decisions", "GET /api/apps/:id/releases",
  "GET /api/apps/:id/agenda", "GET /api/apps/:id/baselines/compare", "GET|PATCH /api/admin/hooks", "POST /api/notifications/:id/read",
  "GET /api/search", "POST /api/apps/:id/comments", "POST /api/workflows/validate", "POST /api/workflows",
  "GET /api/agents", "POST /api/agents/:key/prompts", "GET /api/apps/:id/export-bundle",
  "POST /api/apps/:id/requirements/confirm (lead/ba)", "POST /api/apps/:id/baselines/seal (lead/ba)",
  "GET /api/apps/:id/ai-usage", "POST /api/artifacts/:id/review (lead/ba)", "POST /api/apps/:id/acceptance/run (lead/qa)",
  "GET /api/apps/:id/features", "POST /api/apps/:id/features (lead/ba)", "POST /api/apps/:id/domain-pack/apply (lead/ba)",
  "POST /api/apps/:id/features/distribute (lead/ba)", "POST /api/apps/:id/requirements/impact (lead/ba)",
  "POST /api/apps/:id/requirements/external-refs (lead/ba)", "GET /api/apps/:id/sensitive-route",
  "GET /api/apps/:id/export/requirements.csv", "GET /api/apps/:id/export/requirements.reqif",
  "GET /api/apps/:id/export/spec-kit", "GET /api/apps/:id/export/evidence-pack",
  "GET /api/apps/:id/mocks/sso", "GET /api/apps/:id/mocks/mes",
  "PUT /api/admin/users/:id/expiry (admin)", "PATCH /api/apps/:id/members/:mid/expiry (lead)",
  "GET|POST /api/mcp (Bearer 访问令牌或登录令牌)",
];
