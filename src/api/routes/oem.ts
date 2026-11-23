import { Hono } from "hono";
import { zipSync, strToU8 } from "fflate";
import { effectiveScanFindings, effectiveTestResults } from "@/adapters/stage2-store";
import { buildDocx } from "@/core/docx-export";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { AUTOMOTIVE_DICTIONARY, AUTOMOTIVE_FEATURES, evidenceFiles, mockMes, mockSso, requirementsCsv, requirementsReqif, specKitFiles, zipTextFiles, type ExportCriterion, type ExportRequirement, type ExportTest } from "@/core/oem-pack";
import { dbFail } from "../middleware";
import { appAccess, rejectBusiness, requireRole } from "../perm";
import { parseJson, parseUuid } from "../validate";
import type { AppEnv } from "../context";

export const oemRoutes = new Hono<AppEnv>();

function raiseRpc(error: { message: string } | null, fallback: string): void {
  if (!error) return;
  if (error.message.includes("SDF_FORBIDDEN")) throw new AppError("FORBIDDEN", "当前角色不能做这项操作");
  if (error.message.includes("SDF_NOT_FOUND")) throw new AppError("NOT_FOUND", "记录不存在或您没有访问权限");
  if (error.message.includes("SDF_VALIDATION")) throw new AppError("VALIDATION", "填写的内容不符合要求");
  dbFail(error, fallback);
}

function csvBody(c: { header: (name: string, value: string) => void }, name: string, body: string) {
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${name}"`);
  return body;
}
function zipBody(name: string, body: ReturnType<typeof zipTextFiles>) {
  return { body, headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}"` } };
}
function xmlBody(c: { header: (name: string, value: string) => void }, name: string, body: string) {
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${name}"`);
  return body;
}

oemRoutes.get("/apps/:id/sensitive-route", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const access = await appAccess(c, appId);
  rejectBusiness(access);
  const app = await c.get("db").from("apps").select("classification").eq("id", appId).maybeSingle();
  dbFail(app.error);
  const { serviceQuery } = await import("@/adapters/pg-client");
  const rows = await serviceQuery()(
    `SELECT count(*) FILTER (WHERE enabled AND allowed_for_sensitive)::int AS allowed,
            count(*) FILTER (WHERE enabled)::int AS enabled
     FROM public.llm_providers`,
  );
  const allowed = Number(rows[0]?.["allowed"] ?? 0);
  const classification = String(app.data?.classification ?? "internal");
  const restricted = classification === "sensitive" || classification === "confidential";
  return c.json({
    classification,
    enabled_providers: Number(rows[0]?.["enabled"] ?? 0),
    allowed_for_sensitive: allowed,
    blocked: restricted && allowed === 0,
    reason: restricted && allowed === 0
      ? "这个应用是敏感或机密，但还没有标记为可处理敏感资料的模型服务。调用会被拒绝，不会改用其他模型。"
      : restricted
        ? "只会使用已标记为可处理敏感资料的模型服务。"
        : "当前密级可以使用现有模型服务。改成敏感或机密之后，必须先有可处理敏感资料的服务。",
  });
});

oemRoutes.get("/apps/:id/mocks/sso", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  return c.json(mockSso());
});

oemRoutes.get("/apps/:id/mocks/mes", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  return c.json(mockMes());
});

oemRoutes.get("/apps/:id/features", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const access = await appAccess(c, appId);
  rejectBusiness(access);
  const db = c.get("db");
  const [features, links, iterations, changes] = await Promise.all([
    db.from("features").select("id,code,name,status,iteration_id").eq("app_id", appId).order("code"),
    db.from("feature_requirements").select("feature_id,requirement_id").eq("app_id", appId),
    db.from("iterations").select("id,code,name,status").eq("app_id", appId).order("code"),
    db.from("change_requests").select("code,title,status,business_summary,requirement_codes,created_at").eq("app_id", appId).order("created_at", { ascending: false }).limit(10),
  ]);
  dbFail(features.error); dbFail(links.error); dbFail(iterations.error); dbFail(changes.error);
  const counts = new Map<string, number>();
  for (const link of links.data ?? []) counts.set(String(link.feature_id), (counts.get(String(link.feature_id)) ?? 0) + 1);
  return c.json({
    iterations: iterations.data ?? [],
    changes: changes.data ?? [],
    items: (features.data ?? []).map((item) => ({ ...item, requirement_count: counts.get(String(item.id)) ?? 0 })),
  });
});

oemRoutes.post("/apps/:id/features", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba"]);
  const input = await parseJson(c.req, z.object({ name: z.string().trim().min(2).max(80), iteration_id: z.string().uuid().nullable().optional() }));
  const saved = await c.get("db").rpc("sdf_create_feature", { _app: appId, _name: input.name, _iteration: input.iteration_id ?? null });
  raiseRpc(saved.error, "创建功能失败");
  return c.json(saved.data, 201);
});

oemRoutes.post("/apps/:id/domain-pack/apply", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba"]);
  const db = c.get("db");
  const created: string[] = [];
  for (const feature of AUTOMOTIVE_FEATURES) {
    const saved = await db.rpc("sdf_create_feature", { _app: appId, _name: feature.name, _iteration: null });
    raiseRpc(saved.error, "套用领域包失败");
    const row = saved.data as { code?: string } | null;
    if (row?.code) created.push(row.code);
  }
  const artifact = await db.rpc("sdf_write_artifact", {
    _app: appId,
    _a: { type: "domain_pack", key: "automotive", title: "汽车领域包第一版", content: AUTOMOTIVE_DICTIONARY, agent_role: "architect", citations: [] },
    _step: null,
    _actor: c.get("userId"),
    _source: "import",
  });
  raiseRpc(artifact.error, "写入领域包失败");
  return c.json({ features: created, artifact_id: artifact.data });
});

oemRoutes.post("/apps/:id/features/distribute", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba"]);
  const db = c.get("db");
  const features = await db.from("features").select("id").eq("app_id", appId).order("code");
  dbFail(features.error);
  const list = features.data ?? [];
  if (!list.length) throw new AppError("VALIDATION", "还没有功能，请先套用领域包或新建功能");
  const linked = await db.from("feature_requirements").select("requirement_id").eq("app_id", appId);
  dbFail(linked.error);
  const taken = new Set((linked.data ?? []).map((item) => String(item.requirement_id)));
  const reqs = await db.from("requirements").select("id").eq("app_id", appId).order("code");
  dbFail(reqs.error);
  const buckets = list.map(() => [] as string[]);
  for (const req of reqs.data ?? []) {
    const id = String(req.id);
    if (taken.has(id)) continue;
    buckets[buckets.reduce((best, group, index) => (group.length < buckets[best]!.length ? index : best), 0)]!.push(id);
  }
  let assigned = 0;
  for (let i = 0; i < list.length; i += 1) {
    const ids = buckets[i] ?? [];
    if (!ids.length) continue;
    const saved = await db.rpc("sdf_assign_feature", { _app: appId, _feature: list[i]!.id, _ids: ids });
    raiseRpc(saved.error, "分配需求失败");
    assigned += Number(saved.data ?? 0);
  }
  return c.json({ assigned });
});

oemRoutes.post("/apps/:id/requirements/impact", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba"]);
  const input = await parseJson(c.req, z.object({ code: z.string().trim().min(3).max(40), iteration_id: z.string().uuid().nullable().optional() }));
  const saved = await c.get("db").rpc("sdf_requirement_impact", { _app: appId, _code: input.code, _iteration: input.iteration_id ?? null });
  raiseRpc(saved.error, "影响分析失败");
  return c.json(saved.data);
});

oemRoutes.post("/apps/:id/requirements/external-refs", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba"]);
  const saved = await c.get("db").rpc("sdf_fill_external_refs", { _app: appId });
  raiseRpc(saved.error, "回填甲方编号失败");
  return c.json({ filled: saved.data ?? 0 });
});

async function loadExport(c: Parameters<typeof appAccess>[0], appId: string) {
  const access = await appAccess(c, appId);
  rejectBusiness(access);
  const db = c.get("db");
  const [reqs, cases, testAgg] = await Promise.all([
    db.from("requirements").select("id,code,title,story,status,external_ref,confirmed_at,acceptance_criteria(code,text,requirement_version),current_version").eq("app_id", appId).order("code").limit(2000),
    db.from("test_cases").select("code,requirement_id,ac_code").eq("app_id", appId).limit(5000),
    effectiveTestResults(appId),
  ]);
  dbFail(reqs.error); dbFail(cases.error);
  const tests = testAgg.items;
  const versionFilter = c.req.query("version") ?? "";
  let allowedIds: Set<string> | null = null;
  if (versionFilter) {
    const rel = await db.from("releases").select("iteration_id").eq("app_id", appId).eq("version", versionFilter).maybeSingle();
    dbFail(rel.error);
    const iterationId = rel.data?.iteration_id ? String(rel.data.iteration_id) : "";
    if (iterationId) {
      const features = await db.from("features").select("id").eq("app_id", appId).eq("iteration_id", iterationId);
      dbFail(features.error);
      const featureIds = (features.data ?? []).map((row) => String(row.id));
      const links = featureIds.length ? await db.from("feature_requirements").select("requirement_id").in("feature_id", featureIds) : { data: [], error: null };
      dbFail(links.error);
      allowedIds = new Set((links.data ?? []).map((row) => String(row.requirement_id)));
    }
  }
  const requirements: ExportRequirement[] = [];
  const criteria: ExportCriterion[] = [];
  const idToCode = new Map<string, string>();
  for (const req of reqs.data ?? []) {
    if (allowedIds && !allowedIds.has(String(req.id))) continue;
    idToCode.set(String(req.id), String(req.code));
    requirements.push({
      code: String(req.code), title: String(req.title), story: String(req.story ?? ""), status: String(req.status),
      external_ref: req.external_ref ? String(req.external_ref) : null,
      confirmed_at: req.confirmed_at ? String(req.confirmed_at) : null,
    });
    const version = req.current_version;
    for (const ac of (req.acceptance_criteria ?? []) as { code: string; text: string; requirement_version: number }[]) {
      if (ac.requirement_version !== version) continue;
      criteria.push({ requirement_code: String(req.code), code: ac.code, text: ac.text });
    }
  }
  const acToReq = new Map<string, string>();
  for (const item of criteria) acToReq.set(item.code, item.requirement_code);
  for (const item of cases.data ?? []) {
    if (item.ac_code && item.requirement_id) acToReq.set(String(item.ac_code), idToCode.get(String(item.requirement_id)) ?? "");
  }
  const exportedTests: ExportTest[] = tests.map((item) => ({
    requirement_code: item.ac_code ? acToReq.get(String(item.ac_code)) ?? "" : "",
    ac_code: item.ac_code ? String(item.ac_code) : null,
    name: String(item.name),
    status: String(item.status),
  }));
  return { requirements, criteria, exportedTests };
}

oemRoutes.get("/apps/:id/export/requirements.csv", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const data = await loadExport(c, appId);
  return c.body(csvBody(c, "requirements.csv", requirementsCsv(data.requirements, data.criteria, data.exportedTests)));
});

oemRoutes.get("/apps/:id/export/requirements.reqif", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const data = await loadExport(c, appId);
  return c.body(xmlBody(c, "requirements.reqif", requirementsReqif(data.requirements, data.criteria)));
});

oemRoutes.get("/apps/:id/export/spec-kit", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const access = await appAccess(c, appId);
  rejectBusiness(access);
  const db = c.get("db");
  const [app, constitution, reqs, tasks] = await Promise.all([
    db.from("apps").select("name").eq("id", appId).maybeSingle(),
    db.from("artifacts").select("content").eq("app_id", appId).eq("type", "constitution").eq("key", "main").eq("is_latest", true).limit(1),
    db.from("requirements").select("code,title,story,status,external_ref,confirmed_at").eq("app_id", appId).order("code").limit(500),
    db.from("tasks").select("code,title,allowed_paths").eq("app_id", appId).order("code").limit(200),
  ]);
  dbFail(app.error); dbFail(constitution.error); dbFail(reqs.error); dbFail(tasks.error);
  const files = specKitFiles({
    appName: String(app.data?.name ?? "应用"),
    constitution: String(constitution.data?.[0]?.content ?? ""),
    requirements: (reqs.data ?? []).map((req) => ({
      code: String(req.code), title: String(req.title), story: String(req.story ?? ""), status: String(req.status),
      external_ref: req.external_ref ? String(req.external_ref) : null, confirmed_at: null,
    })),
    tasks: (tasks.data ?? []).map((task) => ({ code: String(task.code), title: String(task.title), paths: (task.allowed_paths ?? []) as string[] })),
  });
  const file = zipBody("spec-kit.zip", zipTextFiles(files));
  return c.body(file.body, 200, file.headers);
});

oemRoutes.get("/apps/:id/export/evidence-pack", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const data = await loadExport(c, appId);
  const db = c.get("db");
  const [app, gates, usage, findingAgg] = await Promise.all([
    db.from("apps").select("name,current_version").eq("id", appId).maybeSingle(),
    db.from("gate_results").select("item_key,status,evidence,created_at").eq("app_id", appId).order("created_at", { ascending: false }).limit(40),
    db.from("artifacts").select("title,model,reviewed_at,edit_ratio").eq("app_id", appId).eq("is_latest", true).order("type").limit(200),
    effectiveScanFindings(appId),
  ]);
  dbFail(app.error); dbFail(gates.error); dbFail(usage.error);
  const findings = findingAgg.items;
  const latest = new Map<string, { item_key: string; status: string; evidence: string }>();
  for (const item of gates.data ?? []) {
    if (!latest.has(String(item.item_key))) latest.set(String(item.item_key), { item_key: String(item.item_key), status: String(item.status), evidence: String(item.evidence ?? "") });
  }
  const coverage = latest.get("ac_coverage");
  const gaps: string[] = [];
  if (!data.exportedTests.length) gaps.push("还没有测试结果，验收结论里对应项目为未执行。");
  if (!coverage || coverage.status !== "PASSED") gaps.push(`验收标准覆盖尚未通过${coverage ? `（${coverage.evidence}）` : ""}。首个版本希望已自动核对并通过的验收标准不低于 85%，当前还没有达到。`);
  const requested = c.req.query("version") ?? "";
  const version = requested || String(app.data?.current_version ?? "");
  const files = evidenceFiles({
    appName: String(app.data?.name ?? "应用"),
    version,
    requirements: data.requirements,
    criteria: data.criteria,
    tests: data.exportedTests,
    findings: findings.map((item) => ({ level: String(item.level), rule_id: String(item.rule_id), path: String(item.path), message: String(item.message) })),
    gate: [...latest.values()],
    usage: (usage.data ?? []).map((item) => ({
      title: String(item.title ?? ""), model: item.model ? String(item.model) : null,
      reviewed_at: item.reviewed_at ? String(item.reviewed_at) : null,
      edit_ratio: item.edit_ratio === null || item.edit_ratio === undefined ? null : Number(item.edit_ratio),
    })),
    gaps,
  });
  const doc = buildDocx(`${String(app.data?.name ?? "应用")} 交付说明`, [
    { heading: "版本", paragraphs: [version || "尚未发布"] },
    { heading: "验收结论", table: [["检查项", "结论", "说明"], ...[...latest.values()].map((item) => [item.item_key, item.status, item.evidence])] },
    { heading: "暂缺", paragraphs: gaps.length ? gaps : ["无"] },
  ]);
  const packed: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(files)) packed[name] = strToU8(text);
  packed["交付说明.docx"] = doc;
  return c.body(zipSync(packed), 200, { "content-type": "application/zip", "content-disposition": "attachment; filename=\"evidence-pack.zip\"" });
});
