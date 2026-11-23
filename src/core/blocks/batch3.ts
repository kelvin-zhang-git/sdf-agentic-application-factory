// 阶段 1 的设计、测试、任务和文档积木。表结构、接口 YAML、上下文包、流水线和 Word 表格由代码生成。
import { z } from "zod";
import { AppError } from "../errors";
import { extractJson } from "../model-gateway";
import { constitutionMarkdown, constitutionSchema } from "./b08";
import { normalizeModel, renderDdl } from "../design/ddl";
import { renderOpenApi, type ApiEndpoint } from "../design/openapi";
import { checkMermaid, renderContextPack } from "../design/context-pack";
import { fillCaseGaps, renderTestDesign, type DesignedCase } from "../design/test-design";
import { normalizeAllowedPaths } from "../design/task-paths";
import { pipelineFilename, renderPipeline, type PipelineTarget } from "../design/pipeline";
import type { Requirement } from "../engine/types";
import type { Block, BlockContext } from "./index";

const looseEntity = z.object({
  name: z.string().max(80), comment: z.string().max(200).optional(),
  fields: z.array(z.object({
    name: z.string().max(80), type: z.string().max(40),
    nullable: z.boolean().optional(), primary_key: z.boolean().optional(), comment: z.string().max(200).optional(),
  })).min(1).max(30),
  foreign_keys: z.array(z.object({ columns: z.array(z.string()).min(1), ref_table: z.string(), ref_columns: z.array(z.string()).min(1) })).max(8).optional(),
  indexes: z.array(z.object({ name: z.string(), columns: z.array(z.string()).min(1), unique: z.boolean().optional() })).max(8).optional(),
});

function artifact(type: string, title: string, content: string, contentJson: unknown, role: string) {
  return { type, key: "main", title, content, content_json: contentJson, agent_role: role, confidence: 0.7 };
}

async function read(ctx: BlockContext, type: string): Promise<string> {
  return (await ctx.store.latestArtifact(ctx.data.app.id, type))?.content ?? "";
}

const B08: Block = {
  key: "B08", name: "工程规范", taskTier: "standard", agentRole: "architect",
  async chunk(ctx) {
    const existing = await ctx.store.latestArtifact(ctx.data.app.id, "constitution");
    if (existing?.content) return { payload: { reused: true }, more: false, progress: "沿用已有工程规范" };
    const r = await ctx.llm.json("standard", constitutionSchema, [
      { role: "system", content: "你是架构师。根据应用说明起草工程规范，不要编造尚未确认的供应商。" },
      { role: "user", content: `应用：${ctx.data.app.name}\n输出 stack、naming、security、performance、other。` },
    ]);
    return { payload: { constitution: r.data }, more: false, progress: "已起草工程规范", tokens: r.usage.total_tokens, calls: r.calls };
  },
  finalize(ctx, payloads) {
    if (payloads[0]?.["reused"]) return { result: {}, summary: "沿用已有工程规范" };
    const c = constitutionSchema.parse(payloads[0]?.["constitution"]);
    return { result: { artifact: artifact("constitution", "CONSTITUTION.md", constitutionMarkdown(ctx.data.app.name, c), c, "architect") }, summary: "已生成工程规范" };
  },
};

const B10: Block = {
  key: "B10", name: "数据模型", taskTier: "standard", agentRole: "architect",
  async chunk(ctx) {
    const reqs = await ctx.store.requirements(ctx.data.app.id);
    const r = await ctx.llm.complete("standard", [
      { role: "system", content: "你是数据架构师。只输出一个 JSON 对象，不要 Markdown。格式：{\"entities\":[{\"name\",\"comment\",\"fields\":[{\"name\",\"type\",\"primary_key\",\"nullable\",\"comment\"}],\"foreign_keys\":[{\"columns\":[],\"ref_table\",\"ref_columns\":[]}]}]}。表名和字段名用小写英文。不要超过 12 张表。" },
      { role: "user", content: reqs.map((q) => `${q.code} ${q.title}`).join("\n").slice(0, 8000) },
    ], 8000);
    let parsed: unknown;
    try { parsed = extractJson(r.content); } catch { throw new AppError("LLM_BAD_FORMAT", `数据模型不是 JSON：${r.content.slice(0, 240)}`); }
    const list = Array.isArray(parsed) ? parsed : (parsed as { entities?: unknown })?.entities;
    if (!Array.isArray(list) || !list.length) throw new AppError("LLM_BAD_FORMAT", `没有实体数组：${r.content.slice(0, 240)}`);
    const entities = normalizeModel(list as z.infer<typeof looseEntity>[]);
    if (!entities.length) throw new AppError("VALIDATION", "数据模型里没有可用的表");
    const ddl = renderDdl(entities);
    return { payload: { entities, ddl }, more: false, progress: `已生成 ${entities.length} 张表`, tokens: r.usage.total_tokens, calls: 1 };
  },
  finalize(_ctx, payloads) {
    const entities = payloads[0]?.["entities"];
    const ddl = String(payloads[0]?.["ddl"] ?? "");
    return { result: { artifact: artifact("data_model", "schema.sql", ddl, { entities }, "architect") }, summary: "已生成数据模型和 DDL" };
  },
};

// 统一调用模型并解析 JSON：透传真实 Token 用量，且不再静默吞掉模型或格式异常，交给引擎做等待或失败处理。
async function modelJson(
  ctx: BlockContext,
  tier: "fast" | "standard",
  system: string,
  user: string,
  maxTokens = 4096,
): Promise<{ data: unknown; tokens: number; calls: number }> {
  const r = await ctx.llm.complete(tier, [
    { role: "system", content: `${system}\n只输出一个 JSON，不要 Markdown。` },
    { role: "user", content: user },
  ], maxTokens);
  let data: unknown;
  try {
    data = extractJson(r.content);
  } catch {
    throw new AppError("LLM_BAD_FORMAT", `模型返回内容不是合法 JSON：${r.content.slice(0, 240)}`);
  }
  return { data, tokens: r.usage.total_tokens, calls: 1 };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const B11: Block = {
  key: "B11", name: "接口说明", taskTier: "standard", agentRole: "architect",
  async chunk(ctx) {
    const reqs = await ctx.store.requirements(ctx.data.app.id);
    const codes = new Set(reqs.map((q) => q.code));
    const reply = await modelJson(
      ctx,
      "standard",
      "你是接口设计师。输出 {\"endpoints\":[{\"method\",\"path\",\"summary\",\"requirement_codes\":[],\"responses\":[{\"status\",\"description\"}]}]}。路径以 / 开头。",
      reqs.slice(0, 40).map((q) => `${q.code} ${q.title}`).join("\n"),
      6000,
    );
    const parsed = reply.data;
    const rawList = Array.isArray(parsed) ? parsed : (asRecord(parsed)?.["endpoints"] as unknown[] | undefined) ?? [];
    const endpoints: ApiEndpoint[] = rawList.flatMap((item) => {
      const row = asRecord(item);
      if (!row) return [];
      const method = String(row["method"] ?? "get").toLowerCase();
      if (!["get", "post", "put", "patch", "delete"].includes(method)) return [];
      let path = String(row["path"] ?? "");
      if (!path) return [];
      if (!path.startsWith("/")) path = `/${path}`;
      path = path.replace(/\{([^}]+)\}/g, (_all, name: string) => `{${name.toLowerCase().replace(/[^a-z0-9_]/g, "") || "id"}}`);
      const names = Array.from(path.matchAll(/\{([a-z_][a-z0-9_]*)\}/g)).map((m) => m[1]!);
      const responses = (Array.isArray(row["responses"]) ? row["responses"] : []).flatMap((response) => {
        const rec = asRecord(response);
        const status = String(rec?.["status"] ?? "200").replace(/\D/g, "").slice(0, 3);
        return status.length === 3 ? [{ status, description: String(rec?.["description"] ?? "完成").slice(0, 300) }] : [];
      });
      return [{
        method: method as ApiEndpoint["method"], path, summary: String(row["summary"] ?? "接口").slice(0, 300),
        requirement_codes: (Array.isArray(row["requirement_codes"]) ? row["requirement_codes"] : []).map(String).filter((code) => codes.has(code)),
        path_params: names, responses: responses.length ? responses : [{ status: "200", description: "完成" }],
      }];
    });
    if (!endpoints.length) throw new AppError("LLM_BAD_FORMAT", "接口说明里没有有效的接口定义");
    const rendered = renderOpenApi(ctx.data.app.name, endpoints);
    const kept = endpoints.filter((_ep, index) => !rendered.errors.some((error) => error.includes(endpoints[index]?.path ?? "")));
    const finalEndpoints = kept.length ? kept : endpoints.slice(0, 1);
    const yaml = renderOpenApi(ctx.data.app.name, finalEndpoints).yaml;
    return { payload: { endpoints: finalEndpoints, yaml }, more: false, progress: `已生成 ${finalEndpoints.length} 个接口`, tokens: reply.tokens, calls: reply.calls };
  },
  finalize(_ctx, payloads) {
    return { result: { artifact: artifact("openapi", "openapi.yaml", String(payloads[0]?.["yaml"] ?? ""), { endpoints: payloads[0]?.["endpoints"] }, "architect") }, summary: "已生成 OpenAPI" };
  },
};

const B12: Block = {
  key: "B12", name: "架构说明", taskTier: "standard", agentRole: "architect",
  async chunk(ctx) {
    const reply = await modelJson(
      ctx,
      "standard",
      "你是架构师。输出 {\"summary\",\"mermaid\"}。图的第一行必须是 flowchart TD。",
      `应用：${ctx.data.app.name}\n${(await read(ctx, "data_model")).slice(0, 3000)}`,
      3000,
    );
    const parsed = asRecord(reply.data);
    const summary = typeof parsed?.["summary"] === "string" ? parsed["summary"].trim() : "";
    if (!summary) throw new AppError("LLM_BAD_FORMAT", "架构说明缺少有效的 summary 字段");
    const diagram = typeof parsed?.["mermaid"] === "string" ? parsed["mermaid"].trim() : "";
    const problem = !diagram || checkMermaid(diagram);
    const mermaid = problem ? "flowchart TD\n  app[应用] --> data[数据]" : diagram;
    return {
      payload: { summary, mermaid, replaced: Boolean(problem) },
      more: false,
      progress: problem ? "模型给的图不合格，已换成示意流程图" : "已生成架构说明",
      tokens: reply.tokens,
      calls: reply.calls,
    };
  },
  finalize(_ctx, payloads) {
    const summary = String(payloads[0]?.["summary"] ?? "");
    const mermaid = String(payloads[0]?.["mermaid"] ?? "");
    const content = `# 架构说明\n\n${summary}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`;
    return { result: { artifact: artifact("design_doc", "架构说明", content, { summary, mermaid }, "architect") }, summary: payloads[0]?.["replaced"] ? "架构图已替换为示意流程图" : "已生成架构说明" };
  },
};

const B09: Block = {
  key: "B09", name: "可交互原型", taskTier: "standard", agentRole: "designer",
  async chunk(ctx) {
    const reqs = await ctx.store.requirements(ctx.data.app.id);
    const reply = await modelJson(
      ctx,
      "standard",
      "你是交互设计师。输出 {\"html\"}。HTML 自包含，主要界面加 data-anchor，不要引用外部地址。",
      reqs.slice(0, 20).map((q) => `${q.code} ${q.title}`).join("\n"),
      6000,
    );
    const parsed = asRecord(reply.data);
    const html = typeof parsed?.["html"] === "string" ? parsed["html"].trim() : "";
    if (!html || !html.includes("<")) throw new AppError("LLM_BAD_FORMAT", "原型生成结果缺少有效的 html 内容");
    return { payload: { html }, more: false, progress: "已生成原型", tokens: reply.tokens, calls: reply.calls };
  },
  finalize(_ctx, payloads) {
    const html = String(payloads[0]?.["html"] ?? "");
    return { result: { artifact: artifact("prototype_html", "可交互原型", html, { anchors: Array.from(html.matchAll(/data-anchor="([^"]+)"/g)).map((m) => m[1]) }, "designer") }, summary: "已生成可交互原型" };
  },
};

const caseSchema = z.object({
  requirement_code: z.string(), ac_code: z.string(), kind: z.enum(["normal", "exception", "boundary"]),
  title: z.string().min(2).max(200), preconditions: z.string().max(500).default(""),
  steps: z.array(z.string().min(1).max(300)).min(1).max(12), expected: z.string().min(1).max(500),
});

function cover(reqs: Requirement[], cases: z.infer<typeof caseSchema>[]): z.infer<typeof caseSchema>[] {
  return fillCaseGaps(reqs, cases);
}

const B18: Block = {
  key: "B18", name: "测试设计", taskTier: "fast", agentRole: "qa",
  async chunk(ctx, seq) {
    const reqs = await ctx.store.requirements(ctx.data.app.id);
    // 每片处理 2 条需求并提高输出上限，避免中文用例过长导致 JSON 截断
    const batchSize = 2;
    const slice = reqs.slice(seq * batchSize, seq * batchSize + batchSize);
    if (!slice.length) return { payload: { cases: [] }, more: false, progress: "没有可设计的需求" };
    const reply = await modelJson(
      ctx,
      "fast",
      "你是测试设计师。输出 {\"cases\":[{\"requirement_code\",\"ac_code\",\"kind\":\"normal|exception|boundary\",\"title\",\"preconditions\",\"steps\":[],\"expected\"}]}。编号必须照抄；每条验收标准最多 2 条用例（1 条正常 + 1 条异常），步骤和预期保持精炼。",
      slice.map((q) => `${q.code} ${q.title}\n${q.criteria.map((c) => `${c.code} ${c.text}`).join("\n")}`).join("\n\n"),
      4096,
    );
    const parsed = asRecord(reply.data);
    const known = new Set(slice.flatMap((q) => q.criteria.map((c) => `${q.code}:${c.code}`)));
    const accepted = (Array.isArray(parsed?.["cases"]) ? parsed["cases"] : []).flatMap((item) => {
      const row = caseSchema.safeParse(item);
      return row.success && known.has(`${row.data.requirement_code}:${row.data.ac_code}`) ? [row.data] : [];
    });
    return {
      payload: { cases: cover(slice, accepted) },
      more: (seq + 1) * batchSize < reqs.length,
      progress: `已覆盖 ${Math.min((seq + 1) * batchSize, reqs.length)}/${reqs.length} 条需求`,
      tokens: reply.tokens,
      calls: reply.calls,
    };
  },
  finalize(ctx, payloads) {
    const cases = payloads.flatMap((p) => (p["cases"] as DesignedCase[] | undefined) ?? []);
    const content = renderTestDesign(ctx.data.app.name, cases);
    return {
      result: {
        test_cases: cases,
        artifact: { type: "test_design", key: "main", title: "测试用例", content, agent_role: "qa", confidence: 0.8 },
      },
      summary: `生成 ${cases.length} 条测试用例`,
    };
  },
};

const taskSchema = z.object({
  title: z.string().min(2).max(120),
  description: z.string().min(4).max(1000),
  requirement_codes: z.array(z.string()).min(1).max(8),
  allowed_paths: z.array(z.string().min(1).max(160)).min(1).max(12),
  forbidden_paths: z.array(z.string().min(1).max(160)).max(12).default([]),
});

const B14: Block = {
  key: "B14", name: "任务与上下文包", taskTier: "standard", agentRole: "lead",
  async chunk(ctx) {
    const reqs = await ctx.store.requirements(ctx.data.app.id);
    const listed = ctx.data.run.inputs["requirement_codes"];
    const wanted = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === "string") : null;
    const scoped = wanted ? reqs.filter((item) => wanted.includes(item.code)) : reqs;
    const featureScoped = typeof ctx.data.run.inputs["feature_id"] === "string";
    const use = (scoped.length ? scoped : reqs).slice(0, featureScoped ? 40 : wanted ? 8 : 40);
    if (!use.length) throw new AppError("VALIDATION", "没有可拆分的需求");
    const reply = await modelJson(
      ctx,
      "standard",
      "你是研发负责人。输出 {\"tasks\":[{\"title\",\"description\",\"requirement_codes\":[],\"allowed_paths\":[],\"forbidden_paths\":[]}]}。需求编号必须照抄；按模块聚合为 6–12 个可执行任务，description 简明扼要（不超过 80 字）。测试目录统一写在 test/ 下（如 test/ 或 test/模块名/），不要使用 tests/。",
      use.map((q) => `${q.code} ${q.title}`).join("\n"),
      6000,
    );
    const parsed = asRecord(reply.data);
    const known = new Map(reqs.map((q) => [q.code, q]));
    const ddl = await read(ctx, "data_model");
    const openapi = await read(ctx, "openapi");
    const proposed = (Array.isArray(parsed?.["tasks"]) ? parsed["tasks"] : []).flatMap((item) => {
      const row = taskSchema.safeParse(item);
      return row.success ? [row.data] : [];
    });
    if (!proposed.length) throw new AppError("LLM_BAD_FORMAT", "任务拆分没有返回有效的 tasks 数组");
    const designed = await ctx.store.testCases(ctx.data.app.id);
    const tasks = proposed.flatMap((task) => {
      const related = task.requirement_codes.filter((code) => known.has(code));
      if (!related.length) return [];
      const criteria = related.flatMap((code) => (known.get(code)?.criteria ?? []).filter((c) => c.code).map((c) => ({ code: c.code!, text: c.text })));
      const allowed = normalizeAllowedPaths(task.allowed_paths);
      const forbidden = Array.from(new Set([...task.forbidden_paths, ".env"]));
      const cases = designed.filter((item) => related.includes(item.requirement_code)).map((item) => ({ ac_code: item.ac_code, kind: item.kind, title: item.title, steps: item.steps, expected: item.expected }));
      const markdown = renderContextPack({
        code: "{{CODE}}", title: task.title, description: task.description, criteria, ddl: ddl.slice(0, 4000), openapi: openapi.slice(0, 4000), allowed_paths: allowed, forbidden_paths: forbidden,
        ...(cases.length ? { cases } : {}),
      });
      return [{ ...task, allowed_paths: allowed, requirement_codes: related, ac_codes: criteria.map((c) => c.code), forbidden_paths: forbidden, context_markdown: markdown }];
    });
    if (!tasks.length) throw new AppError("LLM_BAD_FORMAT", "任务拆分里的需求编号与当前需求库不匹配");
    return { payload: { tasks }, more: false, progress: `已拆成 ${tasks.length} 个任务`, tokens: reply.tokens, calls: reply.calls };
  },
  finalize(_ctx, payloads) {
    return { result: { tasks: payloads[0]?.["tasks"] ?? [] }, summary: `拆出 ${(payloads[0]?.["tasks"] as unknown[] | undefined)?.length ?? 0} 个任务` };
  },
};

const targets: PipelineTarget[] = ["gitlab", "jenkins", "azure", "gitea"];
const B22: Block = {
  key: "B22", name: "流水线模板", taskTier: "fast", agentRole: "ops",
  async chunk(ctx) {
    const constitution = await read(ctx, "constitution");
    const reply = await modelJson(ctx, "fast", "输出 {\"build_command\"}，例如 npm test。", constitution.slice(0, 1500) || "默认 npm test", 400);
    const parsed = asRecord(reply.data);
    const command = (typeof parsed?.["build_command"] === "string" ? parsed["build_command"].trim() : "").slice(0, 200) || "npm test";
    const files = targets.map((target) => ({ target, filename: pipelineFilename(target), content: renderPipeline(target, command) }));
    return { payload: { files }, more: false, progress: "已生成四种流水线模板", tokens: reply.tokens, calls: reply.calls };
  },
  finalize(_ctx, payloads) {
    const files = (payloads[0]?.["files"] as { target: string; filename: string; content: string }[]) ?? [];
    return { result: { artifacts: files.map((file) => ({ type: "pipeline", key: file.target, title: file.filename, content: file.content, agent_role: "ops", confidence: 1 })) }, summary: "已生成流水线模板" };
  },
};

const B26: Block = {
  key: "B26", name: "规格与设计文档", taskTier: "standard", agentRole: "writer",
  async chunk(ctx) {
    const reqs = await ctx.store.requirements(ctx.data.app.id);
    const reply = await modelJson(
      ctx,
      "standard",
      "你是业务分析师。输出 {\"overview\"}，用一段话概括问题和范围。不要输出表格。",
      reqs.slice(0, 30).map((q) => `${q.code} ${q.title}`).join("\n"),
      1500,
    );
    const parsed = asRecord(reply.data);
    const overview = (typeof parsed?.["overview"] === "string" ? parsed["overview"].trim() : "").slice(0, 3000);
    if (!overview) throw new AppError("LLM_BAD_FORMAT", "规格文档缺少有效的 overview 概述");
    const docs = await documentArtifacts(ctx, overview);
    return { payload: { artifacts: docs }, more: false, progress: "已生成需求规格说明书和设计说明书", tokens: reply.tokens, calls: reply.calls };
  },
  finalize(_ctx, payloads) {
    return { result: { artifacts: payloads[0]?.["artifacts"] ?? [] }, summary: "已生成需求规格说明书和设计说明书" };
  },
};

export const BATCH3: Record<string, Block> = { B08, B09, B10, B11, B12, B14, B18, B22, B26 };

export async function documentArtifacts(ctx: BlockContext, overview: string) {
  const reqs = await ctx.store.requirements(ctx.data.app.id);
  const constitution = await read(ctx, "constitution");
  const model = await ctx.store.latestArtifact(ctx.data.app.id, "data_model");
  const apiDoc = await ctx.store.latestArtifact(ctx.data.app.id, "openapi");
  const ddl = model?.content ?? "";
  const openapi = apiDoc?.content ?? "";
  const design = await ctx.store.latestArtifact(ctx.data.app.id, "design_doc");
  const entities = ((model?.content_json as { entities?: { name?: string; fields?: { name?: string; type?: string; comment?: string }[] }[] } | null)?.entities ?? []);
  const fieldRows = [["表", "字段", "类型", "说明"], ...entities.flatMap((entity) => (entity.fields ?? []).map((field) => [entity.name ?? "", field.name ?? "", field.type ?? "", field.comment ?? ""]))];
  const endpoints = ((apiDoc?.content_json as { endpoints?: { method?: string; path?: string; summary?: string; requirement_codes?: string[] }[] } | null)?.endpoints ?? []);
  const apiRows = [["方法", "路径", "摘要", "需求"], ...endpoints.map((ep) => [ep.method ?? "", ep.path ?? "", ep.summary ?? "", (ep.requirement_codes ?? []).join("、")])];
  const reqRows = [["编号", "标题", "优先级", "故事"], ...reqs.map((q) => [q.code, q.title, q.priority, q.story])];
  const acRows = [["编号", "需求", "验收标准"], ...reqs.flatMap((q) => q.criteria.map((c) => [c.code ?? "", q.code, c.text]))];
  const srs = {
    title: `${ctx.data.app.name} 需求规格说明书`,
    sections: [
      { heading: "概述", paragraphs: [overview] },
      { heading: "需求一览", table: reqRows },
      { heading: "验收标准", table: acRows },
    ],
  };
  const designDoc = {
    title: `${ctx.data.app.name} 设计说明书`,
    sections: [
      { heading: "概述", paragraphs: [overview] },
      { heading: "需求追溯", table: [["编号", "标题"], ...reqs.map((q) => [q.code, q.title])] },
      { heading: "工程规范", paragraphs: [constitution || "尚未生成工程规范"] },
      { heading: "数据字典", table: fieldRows.length > 1 ? fieldRows : [["表", "字段", "类型", "说明"], ["尚未生成", "", "", ""]] },
      { heading: "接口", table: apiRows.length > 1 ? apiRows : [["方法", "路径", "摘要", "需求"], ["GET", "/health", openapi ? "见原文" : "尚未生成", ""]] },
      { heading: "架构", paragraphs: [design?.content || "尚未生成架构说明"] },
    ],
  };
  const markdown = (title: string, sections: { heading: string; paragraphs?: string[]; table?: string[][] }[]) =>
    [`# ${title}`, ...sections.flatMap((s) => [`## ${s.heading}`, ...(s.paragraphs ?? []), ...(s.table ?? []).map((row) => `| ${row.join(" | ")} |`)])].join("\n\n");
  return [
    artifact("document_srs", srs.title, markdown(srs.title, srs.sections), srs, "writer"),
    artifact("document_design", designDoc.title, markdown(designDoc.title, designDoc.sections), designDoc, "writer"),
  ];
}
