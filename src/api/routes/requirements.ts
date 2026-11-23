import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { checkSourceFile, decodeText, docxText, MAX_PASTE_CHARS, segmentText } from "@/core/sources";
import { saveSourceBytes, sourceStream } from "@/adapters/fs-storage";
import { Readable } from "node:stream";
import { constitutionMarkdown, constitutionSchema } from "@/core/blocks/b08";
import type { Classification } from "@/core/llm";
import { dbFail } from "../middleware";
import { parseJson, parseUuid } from "../validate";
import { appAccess, requireRole } from "../perm";
import type { AppEnv } from "../context";

export const requirementRoutes = new Hono<AppEnv>();
const KINDS = ["minutes", "interview", "document", "chat", "import"] as const;

requirementRoutes.get("/apps/:id/sources", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const { data, error } = await c.get("db").from("sources").select("id,code,kind,title,meeting_date,participants,mime,size_bytes,parse_status,parse_error,created_at,source_segments(count)").eq("app_id", appId).order("created_at", { ascending: false });
  dbFail(error);
  return c.json({ items: data ?? [] });
});

requirementRoutes.get("/sources/:sid", async (c) => {
  const id = parseUuid(c.req.param("sid"));
  const db = c.get("db");
  const s = await db.from("sources").select("id,app_id,code,kind,title,meeting_date,participants,file_path,parse_status,parse_error,raw_text").eq("id", id).maybeSingle();
  dbFail(s.error);
  if (!s.data) throw new AppError("NOT_FOUND", "资料不存在或您没有访问权限");
  const segs = await db.from("source_segments").select("id,seq,speaker,text,tags").eq("source_id", id).order("seq").limit(2000);
  dbFail(segs.error);
  return c.json({ ...s.data, segments: segs.data ?? [] });
});

requirementRoutes.get("/sources/:sid/download", async (c) => {
  const id = parseUuid(c.req.param("sid"));
  const s = await c.get("db").from("sources").select("file_path,mime,title").eq("id", id).maybeSingle();
  dbFail(s.error);
  const rel = (s.data as { file_path?: string | null; mime?: string | null } | null)?.file_path;
  if (!rel) throw new AppError("NOT_FOUND", "文件不存在或您没有访问权限");
  const nodeStream = sourceStream(rel);
  const web = Readable.toWeb(nodeStream) as ReadableStream;
  return new Response(web, { headers: { "content-type": (s.data as { mime?: string | null }).mime || "application/octet-stream" } });
});

/** B01 stages: ① validate ② create record (RLS: lead/ba) ③ store file (Storage RLS) ④ parse outside any transaction ⑤ one-transaction segment write. */
requirementRoutes.post("/apps/:id/sources", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const access = await appAccess(c, appId);
  requireRole(access, ["lead", "ba"], "只有负责人或需求分析师可以上传资料");
  const form = await c.req.formData().catch(() => { throw new AppError("VALIDATION", "上传内容格式不正确"); });
  const meta = z.object({
    title: z.string().trim().min(1, "请填写标题").max(200), kind: z.enum(KINDS).default("minutes"),
    meeting_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    participants: z.array(z.string().trim().min(1).max(50)).max(50).default([]), text: z.string().max(MAX_PASTE_CHARS, "粘贴文本超过 20 万字").nullable().default(null),
  }).safeParse({
    title: form.get("title"), kind: form.get("kind") || undefined, meeting_date: form.get("meeting_date") || null,
    participants: String(form.get("participants") ?? "").split(/[,，、\n]/).map((x) => x.trim()).filter(Boolean), text: form.get("text") || null,
  });
  if (!meta.success) throw new AppError("VALIDATION", meta.error.issues[0]?.message ?? "填写的内容不符合要求");
  const file = form.get("file");
  let bytes: Uint8Array | null = null; let ext: ReturnType<typeof checkSourceFile> | null = null; let name = ""; let mime = "";
  if (file && typeof file !== "string") {
    name = file.name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-120); mime = file.type;
    ext = checkSourceFile(name, mime, file.size);
    bytes = new Uint8Array(await file.arrayBuffer());
  } else if (!meta.data.text?.trim()) throw new AppError("VALIDATION", "请选择文件或粘贴文本");

  const db = c.get("db");
  const id = crypto.randomUUID();
  const code = await c.get("deps").sys.nextCode(appId, "SRC");
  const path = bytes ? `${appId}/${id}/${name}` : null;
  const ins = await db.from("sources").insert({ id, app_id: appId, code, kind: meta.data.kind, title: meta.data.title, meeting_date: meta.data.meeting_date,
    participants: meta.data.participants, file_path: path, mime: mime || (bytes ? null : "text/plain"), size_bytes: bytes?.byteLength ?? meta.data.text!.length, created_by: c.get("userId") }).select("id,code").single();
  dbFail(ins.error, "新建资料失败");
  const cmd = c.get("deps").commands;
  try {
    if (bytes && path) {
      await saveSourceBytes(path, bytes);
    }
    let text = meta.data.text ?? "";
    if (bytes && ext) text = ext === "docx" ? docxText(bytes) : ext === "pdf" ? await c.get("deps").pdfText(bytes).catch(() => { throw new AppError("VALIDATION", "无法读取 PDF 文字，请确认不是扫描件"); }) : decodeText(bytes);
    const segments = segmentText(text);
    const n = await cmd.writeSegments(id, text.slice(0, 1_000_000), segments);
    await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), app_id: appId, action: "source.created", target_type: "source", target_id: id, detail: { segments: n, kind: meta.data.kind } });
    return c.json({ id, code: ins.data!.code, segments: n }, 201);
  } catch (e) {
    const msg = e instanceof AppError ? e.message : "解析失败";
    await cmd.markSourceFailed(id, msg).catch(() => undefined);
    throw e instanceof AppError ? new AppError(e.code, `${msg}（资料 ${ins.data!.code} 已标记为解析失败，文件已保留）`) : e;
  }
});

requirementRoutes.get("/apps/:id/requirements", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const db = c.get("db");
  const { data, error } = await db.from("requirements").select("*, acceptance_criteria(id,code,format,text,requirement_version)").eq("app_id", appId).order("code");
  dbFail(error);
  return c.json({ items: (data ?? []).map((r) => ({ ...r, acceptance_criteria: ((r.acceptance_criteria ?? []) as { requirement_version: unknown }[]).filter((a) => a.requirement_version === r.current_version) })) });
});

requirementRoutes.get("/requirements/:rid/versions", async (c) => {
  const id = parseUuid(c.req.param("rid"));
  const { data, error } = await c.get("db").from("requirement_versions").select("id,version,snapshot,change_reason,step_run_id,changed_by,created_at").eq("requirement_id", id).order("version");
  dbFail(error);
  return c.json({ items: data ?? [] });
});

requirementRoutes.post("/requirements/:rid/edit", async (c) => {
  const id = parseUuid(c.req.param("rid"));
  const input = await parseJson(c.req, z.object({
    story: z.string().max(4000).optional(), priority: z.enum(["must", "should", "could", "wont"]).optional(), status: z.enum(["draft", "approved", "deprecated"]).optional(),
    criteria: z.array(z.object({ format: z.enum(["ears", "gwt"]), text: z.string().trim().min(4).max(1000) })).min(1).max(20).optional(), reason: z.string().trim().min(2, "请填写修改原因").max(500),
  }));
  const r = await c.get("db").from("requirements").select("id,app_id").eq("id", id).maybeSingle();
  dbFail(r.error);
  if (!r.data) throw new AppError("NOT_FOUND", "需求不存在或您没有访问权限");
  requireRole(await appAccess(c, r.data.app_id), ["lead", "ba"], "只有负责人或需求分析师可以修改需求");
  const { reason, ...patch } = input;
  const version = await c.get("deps").commands.editRequirement(id, c.get("userId"), patch, reason, c.get("traceId"));
  return c.json({ ok: true, version });
});

requirementRoutes.get("/apps/:id/findings", async (c) => {
  const { data, error } = await c.get("db").from("analysis_findings").select("*").eq("app_id", parseUuid(c.req.param("id"))).order("created_at", { ascending: false }).limit(500);
  dbFail(error); return c.json({ items: data ?? [] });
});
requirementRoutes.patch("/findings/:fid", async (c) => {
  const input = await parseJson(c.req, z.object({ status: z.enum(["open", "resolved", "accepted_risk"]) }));
  const { data, error } = await c.get("db").from("analysis_findings").update({ status: input.status }).eq("id", parseUuid(c.req.param("fid"))).select("id,app_id").maybeSingle();
  dbFail(error);
  if (!data) throw new AppError("FORBIDDEN", "没有权限处理该问题");
  await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), app_id: data.app_id, action: "finding.status", target_type: "finding", target_id: data.id, detail: { status: input.status } });
  return c.json({ ok: true });
});

requirementRoutes.get("/apps/:id/questions", async (c) => {
  const { data, error } = await c.get("db").from("clarification_questions").select("*, contacts(name,title)").eq("app_id", parseUuid(c.req.param("id"))).order("code");
  dbFail(error); return c.json({ items: data ?? [] });
});
requirementRoutes.patch("/questions/:qid", async (c) => {
  const input = await parseJson(c.req, z.object({ answer: z.string().trim().min(1).max(5000, "回答不能超过 5000 字") }));
  const { data, error } = await c.get("db").from("clarification_questions").update({ answer: input.answer, status: "answered" }).eq("id", parseUuid(c.req.param("qid"))).select("id,app_id").maybeSingle();
  dbFail(error);
  if (!data) throw new AppError("FORBIDDEN", "没有权限录入回答");
  await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), app_id: data.app_id, action: "question.answered", target_type: "question", target_id: data.id });
  return c.json({ ok: true });
});

/** 「根据回答更新需求」：B02 update logic; every change becomes a new requirement version via RPC. */
requirementRoutes.post("/apps/:id/questions/apply", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba"], "只有负责人或需求分析师可以据回答更新需求");
  const db = c.get("db");
  const [qs, reqs, app] = await Promise.all([
    db.from("clarification_questions").select("id,code,question,answer,target_refs").eq("app_id", appId).eq("status", "answered"),
    db.from("requirements").select("id,code,title,story,current_version,acceptance_criteria(format,text,requirement_version)").eq("app_id", appId).neq("status", "deprecated"),
    db.from("apps").select("id,classification,redact_before_llm,redact_terms").eq("id", appId).single(),
  ]);
  dbFail(qs.error); dbFail(reqs.error); dbFail(app.error);
  if (!qs.data?.length) throw new AppError("VALIDATION", "没有已回答、待应用的问题");
  const { gatewayFor } = await import("@/adapters/engine-store");
  const gw = await gatewayFor({ id: appId, classification: app.data!.classification as Classification, redact_before_llm: app.data!.redact_before_llm, redact_terms: (app.data!.redact_terms as string[] | undefined) ?? [] }, c.get("traceId"), c.get("userId"), undefined, "requirement_analyst");
  const schema = z.object({ updates: z.array(z.object({ code: z.string(), story: z.string().max(2000), criteria: z.array(z.object({ format: z.enum(["ears", "gwt"]), text: z.string().min(4).max(1000) })).min(1), reason: z.string().max(300) })) });
  const r = await gw.json("standard", schema, [
    { role: "system", content: "你是需求分析师。根据业务方对澄清问题的回答，更新受影响需求的描述和验收标准。code 必须从给定需求编号里原样复制，不能改写或新编。回答改变了规则、范围或验收口径时，至少更新一条相关需求。" },
    { role: "user", content: `输出 {"updates":[{"code":"与下面编号完全一致","story","criteria":[{"format":"ears或gwt","text"}],"reason"}]}\n\n需求：\n${(reqs.data ?? []).map((q) => `${q.code}｜${q.title}\n${q.story}\n验收：${((q.acceptance_criteria ?? []) as { requirement_version: unknown; text: string }[]).filter((a) => a.requirement_version === q.current_version).map((a) => a.text).join("；")}`).join("\n\n")}\n\n问答：\n${qs.data.map((q) => `${q.code} 问：${q.question}\n答：${q.answer}`).join("\n")}` },
  ]);
  const byCode = new Map((reqs.data ?? []).map((q) => [q.code, q.id]));
  let changed = 0;
  for (const u of r.data.updates) {
    const rid = byCode.get(u.code.trim()); if (!rid) continue;
    await c.get("deps").commands.editRequirement(rid, c.get("userId"), { story: u.story, criteria: u.criteria }, `根据澄清回答更新：${u.reason}`.slice(0, 500), c.get("traceId"));
    changed += 1;
  }
  const unmatched = r.data.updates.map((u) => u.code.trim()).filter((code) => !byCode.has(code));
  // 模型给了编号但一个都对不上时，保留「已回答」，方便原样再试一次
  if (r.data.updates.length > 0 && changed === 0) {
    return c.json({ ok: false, updated: 0, applied: 0, unmatched });
  }
  for (const q of qs.data) { const u = await db.from("clarification_questions").update({ status: "applied" }).eq("id", q.id); dbFail(u.error); }
  return c.json({ ok: true, updated: changed, applied: qs.data.length, unmatched });
});

requirementRoutes.get("/apps/:id/constitution", async (c) => {
  const { data, error } = await c.get("db").from("artifacts").select("id,version,title,content,content_json,created_at,source").eq("app_id", parseUuid(c.req.param("id"))).eq("type", "constitution").eq("key", "main").order("version", { ascending: false }).limit(20);
  dbFail(error); return c.json({ items: data ?? [] });
});
requirementRoutes.put("/apps/:id/constitution", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba", "architect"], "只有负责人、需求分析师或架构师可以编辑工程规范");
  const raw = await c.req.json().catch(() => null);
  const parsed = constitutionSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "请完整填写必填项");
  const app = await c.get("db").from("apps").select("name").eq("id", appId).single();
  dbFail(app.error);
  const id = await c.get("deps").commands.editArtifact(appId, c.get("userId"), { type: "constitution", key: "main", title: "CONSTITUTION.md", content: constitutionMarkdown(app.data!.name, parsed.data), content_json: parsed.data }, c.get("traceId"));
  return c.json({ ok: true, id });
});
requirementRoutes.post("/apps/:id/constitution/draft", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba", "architect"], "没有起草工程规范的权限");
  const app = await c.get("db").from("apps").select("id,name,description,classification,redact_before_llm,redact_terms").eq("id", appId).single();
  dbFail(app.error);
  const { gatewayFor } = await import("@/adapters/engine-store");
  const gw = await gatewayFor({ id: appId, classification: app.data!.classification as Classification, redact_before_llm: app.data!.redact_before_llm, redact_terms: (app.data!.redact_terms as string[] | undefined) ?? [] }, c.get("traceId"), c.get("userId"), undefined, "architect");
  const r = await gw.json("standard", constitutionSchema, [
    { role: "system", content: "你是架构师。为应用起草简洁的工程规范草稿，字段：stack 技术栈、naming 命名规范、security 安全禁止项、performance 性能要求、other 其他。" },
    { role: "user", content: `应用：${app.data!.name}\n说明：${app.data!.description}\n输出 {"stack","naming","security","performance","other"}` },
  ]);
  return c.json({ ok: true, draft: r.data });
});

function raiseRpc(error: { message: string } | null, fallback: string) {
  if (!error) return;
  if (error.message.includes("SDF_FORBIDDEN")) throw new AppError("FORBIDDEN", "只有负责人或需求分析师可以确认需求");
  if (error.message.includes("还没有已确认")) throw new AppError("VALIDATION", "还没有已确认的需求");
  if (error.message.includes("SDF_NOT_FOUND")) throw new AppError("NOT_FOUND", "制品不存在或您没有访问权限");
  dbFail(error, fallback);
}

requirementRoutes.post("/apps/:id/requirements/confirm", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba"], "只有负责人或需求分析师可以确认需求");
  const input = await parseJson(c.req, z.object({ ids: z.array(z.string().uuid()).min(1).max(500), note: z.string().trim().max(500).optional() }));
  const saved = await c.get("db").rpc("sdf_confirm_requirements", { _app: appId, _ids: input.ids });
  raiseRpc(saved.error, "确认需求失败");
  if (input.note) {
    for (const id of input.ids) {
      const row = await c.get("db").from("comments").insert({ app_id: appId, target_kind: "requirement", target_id: id, body: input.note, author_id: c.get("userId") });
      dbFail(row.error, "保存批注失败");
    }
  }
  const left = await c.get("db").from("requirements").select("id").eq("app_id", appId).eq("status", "draft").limit(1);
  dbFail(left.error);
  let baseline: string | null = null;
  if (!(left.data ?? []).length) {
    const sealed = await c.get("db").rpc("sdf_seal_baseline", { _app: appId });
    if (!sealed.error) baseline = typeof sealed.data === "string" ? sealed.data : null;
  }
  await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), app_id: appId, action: "requirement.confirmed", detail: { count: saved.data } });
  return c.json({ confirmed: saved.data, baseline });
});

requirementRoutes.post("/apps/:id/requirements/return", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba"], "只有负责人或需求分析师可以退回需求");
  const input = await parseJson(c.req, z.object({ ids: z.array(z.string().uuid()).min(1).max(500), note: z.string().trim().min(2).max(500) }));
  const saved = await c.get("db").rpc("sdf_return_requirements", { _app: appId, _ids: input.ids });
  raiseRpc(saved.error, "退回需求失败");
  for (const id of input.ids) {
    const row = await c.get("db").from("comments").insert({ app_id: appId, target_kind: "requirement", target_id: id, body: input.note, author_id: c.get("userId") });
    dbFail(row.error, "保存批注失败");
  }
  await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), app_id: appId, action: "requirement.returned", detail: { count: saved.data } });
  return c.json({ returned: saved.data });
});

requirementRoutes.post("/apps/:id/baselines/seal", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba"], "只有负责人或需求分析师可以生成基线");
  const saved = await c.get("db").rpc("sdf_seal_baseline", { _app: appId });
  raiseRpc(saved.error, "生成基线失败");
  await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), app_id: appId, action: "baseline.sealed", detail: { version: saved.data } });
  return c.json({ version: saved.data });
});

requirementRoutes.get("/apps/:id/ai-usage", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const rows = await c.get("db").from("artifacts").select("id,type,key,title,model,agent_role,step_run_id,reviewed_by,reviewed_at,edit_ratio,status,created_at").eq("app_id", appId).eq("is_latest", true).order("created_at");
  dbFail(rows.error);
  const items = rows.data ?? [];
  if (c.req.query("format") === "csv") {
    const header = "title,type,model,agent_role,status,reviewed_at,edit_ratio,step_run_id";
    const body = items.map((row) => [row.title, row.type, row.model, row.agent_role, row.status, row.reviewed_at, row.edit_ratio, row.step_run_id].map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    return c.body(`${header}\n${body}\n`, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=ai-usage.csv" });
  }
  return c.json({ items });
});

requirementRoutes.post("/artifacts/:id/review", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, z.object({ status: z.enum(["approved", "rejected"]), content: z.string().max(200_000).optional() }));
  const current = await c.get("db").from("artifacts").select("id,app_id,content,is_latest").eq("id", id).maybeSingle();
  dbFail(current.error);
  if (!current.data?.is_latest) throw new AppError("NOT_FOUND", "制品不存在或已不是最新版本");
  requireRole(await appAccess(c, current.data.app_id), ["lead", "ba"], "只有负责人或需求分析师可以审核制品");
  const { editRatio } = await import("@/core/acceptance-run");
  const ratio = input.content === undefined ? 0 : editRatio(String(current.data.content ?? ""), input.content);
  const saved = await c.get("db").rpc("sdf_review_artifact", { _id: id, _status: input.status, _content: input.content ?? null, _ratio: ratio });
  raiseRpc(saved.error, "审核制品失败");
  return c.json({ id: saved.data, edit_ratio: ratio });
});

requirementRoutes.post("/apps/:id/acceptance/run", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "qa"], "只有负责人或测试可以运行验收");
  const rows = await c.get("db").from("artifacts").select("title,content").eq("app_id", appId).eq("type", "scaffold").eq("is_latest", true);
  dbFail(rows.error);
  const files = (rows.data ?? []).map((row) => ({ path: String(row.title), content: String(row.content ?? "") })).filter((file) => file.path && !file.path.endsWith(".md"));
  if (!files.some((file) => file.path === "test/acceptance.test.js")) throw new AppError("VALIDATION", "请先运行模板脚手架，生成可执行的验收测试");
  const { runNodeTests, secretSarif } = await import("@/core/acceptance-run");
  const { storeReports } = await import("@/adapters/stage2-store");
  const junit = await runNodeTests(files).catch((error: unknown) => {
    throw new AppError("VALIDATION", error instanceof Error ? error.message : "验收测试没有跑起来");
  });
  const saved = await storeReports(appId, junit, secretSarif(files));
  await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), app_id: appId, action: "acceptance.ran", detail: saved });
  return c.json(saved);
});
