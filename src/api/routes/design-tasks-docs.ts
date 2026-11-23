import { Hono, type Context } from "hono";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { renderDdl, type ModelEntity } from "@/core/design/ddl";
import { markdownToSections, docxAttachment, type DocSection } from "@/core/docx-export";
import { withRequirementLink } from "@/core/report-link";
import { TECHNICAL_EXPORT_TYPES, buildFromTemplate } from "@/core/document-template";
import { loadTemplateForExport } from "../template-store";
import type { Classification } from "@/core/llm";
import { dbFail } from "../middleware";
import { parseUuid } from "../validate";
import { appAccess, rejectBusiness, requireRole } from "../perm";
import type { AppEnv } from "../context";

export const designRoutes = new Hono<AppEnv>();

const fieldSchema = z.object({
  name: z.string(), type: z.string(), nullable: z.boolean().optional(), primary_key: z.boolean().optional(),
  comment: z.string().optional(), default: z.string().nullable().optional(),
});
const modelSchema = z.object({
  entities: z.array(z.object({
    name: z.string(), comment: z.string().optional(), fields: z.array(fieldSchema).min(1),
    foreign_keys: z.array(z.object({ columns: z.array(z.string()), ref_table: z.string(), ref_columns: z.array(z.string()) })).optional(),
    indexes: z.array(z.object({ name: z.string(), columns: z.array(z.string()), unique: z.boolean().optional() })).optional(),
  })).min(1),
});

async function latest(c: Context<AppEnv>, appId: string, type: string, key = "main") {
  const row = await c.get("db").from("artifacts").select("id,version,title,content,content_json,created_at").eq("app_id", appId).eq("type", type).eq("key", key).eq("is_latest", true).maybeSingle();
  dbFail(row.error);
  return row.data;
}

designRoutes.get("/apps/:id/data-model", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  rejectBusiness(await appAccess(c, appId));
  return c.json({ item: await latest(c, appId, "data_model") });
});

designRoutes.put("/apps/:id/data-model", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "architect"], "只有负责人或架构师可以修改数据模型");
  const parsed = modelSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION", "数据模型格式不正确");
  let ddl = "";
  try { ddl = renderDdl(parsed.data.entities as ModelEntity[]); } catch (error) {
    throw new AppError("VALIDATION", error instanceof Error ? error.message : "数据模型无法生成 DDL");
  }
  const id = await c.get("deps").commands.editArtifact(appId, c.get("userId"), {
    type: "data_model", key: "main", title: "schema.sql", content: ddl, content_json: parsed.data,
  }, c.get("traceId"));
  return c.json({ ok: true, id });
});

designRoutes.get("/apps/:id/data-model/schema.sql", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  rejectBusiness(await appAccess(c, appId));
  const item = await latest(c, appId, "data_model");
  if (!item) throw new AppError("NOT_FOUND", "还没有数据模型");
  return c.body(item.content, 200, { "Content-Type": "text/plain; charset=utf-8" });
});

designRoutes.get("/apps/:id/openapi.yaml", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  rejectBusiness(await appAccess(c, appId));
  const item = await latest(c, appId, "openapi");
  if (!item) throw new AppError("NOT_FOUND", "还没有接口说明");
  return c.body(item.content, 200, { "Content-Type": "application/yaml; charset=utf-8" });
});

designRoutes.get("/apps/:id/prototype", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const comments = await c.get("db").from("prototype_comments").select("id,anchor,body,resolved,created_at").eq("app_id", appId).order("created_at", { ascending: false }).limit(100);
  dbFail(comments.error);
  return c.json({ item: await latest(c, appId, "prototype_html"), comments: comments.data ?? [] });
});

designRoutes.post("/apps/:id/prototype/comments", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const parsed = z.object({ anchor: z.string().trim().min(1).max(120), body: z.string().trim().min(2).max(2000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION", "请填写锚点和留言");
  const saved = await c.get("db").rpc("add_prototype_comment", { _app: appId, _actor: c.get("userId"), _anchor: parsed.data.anchor, _body: parsed.data.body, _trace: c.get("traceId") });
  dbFail(saved.error);
  return c.json({ ok: true, id: saved.data });
});

designRoutes.post("/apps/:id/prototype/revise", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba", "business"], "没有修订原型的权限");
  const current = await latest(c, appId, "prototype_html");
  if (!current) throw new AppError("NOT_FOUND", "还没有原型");
  const comments = await c.get("db").from("prototype_comments").select("anchor,body").eq("app_id", appId).eq("resolved", false).limit(30);
  dbFail(comments.error);
  const app = await c.get("db").from("apps").select("name,classification,redact_before_llm,redact_terms").eq("id", appId).single();
  dbFail(app.error);
  const { gatewayFor } = await import("@/adapters/engine-store");
  const gw = await gatewayFor({ id: appId, classification: app.data!.classification as Classification, redact_before_llm: app.data!.redact_before_llm, redact_terms: (app.data!.redact_terms as string[] | undefined) ?? [] }, c.get("traceId"), c.get("userId"), undefined, "business_analyst");
  const r = await gw.json("standard", z.object({ html: z.string().min(40).max(50000) }), [
    { role: "system", content: "你是交互设计师。按留言修订原型，保留 data-anchor。只输出自包含 HTML，不要引用外部地址。" },
    { role: "user", content: `当前原型：\n${current.content.slice(0, 20000)}\n\n留言：\n${(comments.data ?? []).map((x) => `${x.anchor}：${x.body}`).join("\n")}` },
  ], 6000);
  const id = await c.get("deps").commands.editArtifact(appId, c.get("userId"), {
    type: "prototype_html", key: "main", title: "可交互原型", content: r.data.html,
    content_json: { anchors: Array.from(r.data.html.matchAll(/data-anchor="([^"]+)"/g)).map((m) => m[1]) },
  }, c.get("traceId"));
  return c.json({ ok: true, id, version_note: "已按留言生成新版本" });
});

designRoutes.get("/apps/:id/tasks", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  rejectBusiness(await appAccess(c, appId));
  const rows = await c.get("db").from("tasks").select("id,code,title,description,status,assignee_kind,requirement_codes,allowed_paths,forbidden_paths,updated_at").eq("app_id", appId).order("code");
  dbFail(rows.error);
  return c.json({ items: rows.data ?? [] });
});

designRoutes.get("/apps/:id/tasks/:code/context", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  rejectBusiness(await appAccess(c, appId));
  const task = await c.get("db").from("tasks").select("code,context_artifact_id").eq("app_id", appId).eq("code", c.req.param("code")).maybeSingle();
  dbFail(task.error);
  if (!task.data?.context_artifact_id) throw new AppError("NOT_FOUND", "这个任务还没有上下文包");
  const pack = await c.get("db").from("artifacts").select("content").eq("id", task.data.context_artifact_id).maybeSingle();
  dbFail(pack.error);
  return c.json({ code: task.data.code, content: pack.data?.content ?? "" });
});

designRoutes.patch("/tasks/:taskId", async (c) => {
  const taskId = parseUuid(c.req.param("taskId"));
  const parsed = z.object({ status: z.enum(["todo", "doing", "review", "blocked", "done"]) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION", "状态不正确");
  const saved = await c.get("db").rpc("update_task_status", { _task: taskId, _actor: c.get("userId"), _status: parsed.data.status, _trace: c.get("traceId") });
  dbFail(saved.error);
  return c.json({ ok: true });
});

designRoutes.get("/apps/:id/test-cases", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  rejectBusiness(await appAccess(c, appId));
  const [cases, requirements, doc] = await Promise.all([
    c.get("db").from("test_cases").select("id,code,ac_code,kind,title,preconditions,steps,expected").eq("app_id", appId).order("code").limit(4000),
    c.get("db").from("requirements").select("code,current_version,acceptance_criteria(code,requirement_version)").eq("app_id", appId).neq("status", "deprecated").limit(500),
    c.get("db").from("artifacts").select("id,title").eq("app_id", appId).eq("type", "test_design").eq("key", "main").eq("is_latest", true).maybeSingle(),
  ]);
  dbFail(cases.error); dbFail(requirements.error); dbFail(doc.error);
  const items = cases.data ?? [];
  const criteria = (requirements.data ?? []).flatMap((req) => (req.acceptance_criteria ?? []).filter((ac: { requirement_version: number }) => ac.requirement_version === req.current_version));
  const gaps = criteria.flatMap((ac) => {
    const mine = items.filter((item) => item.ac_code === ac.code);
    const missing: string[] = [];
    if (!mine.some((item) => item.kind === "normal")) missing.push("正常");
    if (!mine.some((item) => item.kind === "exception" || item.kind === "boundary")) missing.push("例外或边界");
    return missing.length ? [{ ac_code: ac.code, missing }] : [];
  });
  return c.json({ items, gaps, document: doc.data ?? null });
});

designRoutes.post("/apps/:id/test-design/publish", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "qa"], "只有负责人或测试可以生成测试用例文档");
  try {
    const { publishTestDesign } = await import("@/adapters/test-design-store");
    return c.json(await publishTestDesign(appId, c.get("userId")));
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成测试用例失败";
    if (message.includes("SDF_")) throw new AppError("VALIDATION", "测试用例没有写进去");
    throw new AppError("VALIDATION", message);
  }
});

designRoutes.get("/apps/:id/documents", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  rejectBusiness(await appAccess(c, appId));
  const rows = await c.get("db").from("artifacts").select("id,type,title,version,created_at").eq("app_id", appId).in("type", ["document_srs", "document_design"]).eq("is_latest", true).order("type");
  dbFail(rows.error);
  return c.json({ items: rows.data ?? [] });
});

const CLASS_LABEL: Record<string, string> = { public: "公开", internal: "内部", sensitive: "敏感", confidential: "机密" };

designRoutes.get("/artifacts/:id/export.docx", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const row = await c.get("db").from("artifacts").select("app_id,type,title,version,content,content_json,created_at,agent_role,step_run_id").eq("id", id).maybeSingle();
  dbFail(row.error);
  if (!row.data) throw new AppError("NOT_FOUND", "文档不存在或您没有访问权限");
  const access = await appAccess(c, row.data.app_id);
  if (TECHNICAL_EXPORT_TYPES.has(row.data.type)) rejectBusiness(access);
  const app = await c.get("db").from("apps").select("name,classification").eq("id", row.data.app_id).maybeSingle();
  dbFail(app.error);
  let content = row.data.content;
  // 需求清单和分析报告导出前，用需求库里的正式编号补上与标题的对应。
  if (row.data.type === "requirements" || row.data.type === "analysis") {
    const reqs = await c.get("db").from("requirements").select("code,title,priority").eq("app_id", row.data.app_id).neq("status", "deprecated").order("code");
    dbFail(reqs.error);
    content = withRequirementLink(row.data.type, content, reqs.data ?? []);
  }
  const json = row.data.content_json as { title?: string; sections?: DocSection[] } | null;
  const title = json?.title || row.data.title;
  const sections = json?.sections?.length ? json.sections : markdownToSections(content);
  const override = c.req.query("template_id");
  if (override && !access.isAdmin) throw new AppError("FORBIDDEN", "只有管理员可以指定模板预览");
  const versionRaw = c.req.query("template_version");
  const templateVersion = versionRaw ? Number(versionRaw) : undefined;
  if (versionRaw && !Number.isInteger(templateVersion)) throw new AppError("VALIDATION", "版本号不正确");
  const step = row.data.step_run_id
    ? await c.get("db").from("step_runs").select("step_key,block_key").eq("id", row.data.step_run_id).maybeSingle()
    : { data: null, error: null };
  dbFail(step.error);
  const snap = await loadTemplateForExport(c.get("db"), row.data.type, override ? parseUuid(override) : null, templateVersion);
  const bytes = buildFromTemplate(title, sections, snap, {
    appName: app.data?.name,
    classification: CLASS_LABEL[app.data?.classification ?? ""] ?? app.data?.classification ?? undefined,
    version: `v${row.data.version}`,
    generatedAt: new Date(row.data.created_at).toLocaleString("zh-CN", { hour12: false }),
    stepInfo: step.data ? `${step.data.step_key} / ${step.data.block_key}` : undefined,
    agentRole: row.data.agent_role ?? undefined,
  });
  const filename = `${title}.docx`;
  const file = docxAttachment(bytes, filename);
  return c.body(file.body, 200, file.headers);
});
