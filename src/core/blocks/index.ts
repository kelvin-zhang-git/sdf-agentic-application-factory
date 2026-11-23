// Blocks B01–B04: manifest + chunk + finalize. Blocks reach models only through ctx.llm (ModelGateway).
import { z } from "zod";
import { AppError } from "../errors";
import type { TaskTier } from "../llm";
import type { ModelGateway } from "../model-gateway";
import type { EngineStore, Requirement, Segment, StepContextData } from "../engine/types";
import { BATCH3 } from "./batch3";
import { BATCH4 } from "./batch4";
import { BATCH5 } from "./batch5";
import { BATCH6 } from "./batch6";
import { BATCH7 } from "./batch7";
import { BATCH8 } from "./batch8";
import { analysisReportMarkdown, type ReportFinding, type ReportReq } from "../report-link";

export interface BlockContext { data: StepContextData; store: EngineStore; llm: ModelGateway; options: Record<string, unknown>; feedback: string | null }
export interface ChunkOut { payload: Record<string, unknown>; more: boolean; progress: string; tokens?: number; calls?: number }
export interface Block {
  key: string; name: string; taskTier: TaskTier; agentRole: string;
  chunk(ctx: BlockContext, seq: number): Promise<ChunkOut>;
  finalize(ctx: BlockContext, payloads: Record<string, unknown>[]): { result: Record<string, unknown>; summary: string };
}

export const VAGUE_WORDS = ["尽快", "友好", "快速", "适当", "大概", "灵活", "及时", "方便", "高效", "等等", "差不多", "尽量"];
const sourceIds = (ctx: BlockContext) => {
  const v = ctx.data.run.inputs["source_ids"];
  return Array.isArray(v) && v.length ? v.filter((x): x is string => typeof x === "string") : null;
};
const segLine = (s: Segment, n: number) => `[${n}] ${s.speaker ? s.speaker + "：" : ""}${s.text.slice(0, 600)}`;
const feedbackNote = (ctx: BlockContext) => ctx.feedback ? `\n上次被退回，退回意见：${ctx.feedback}\n请据此改进。` : "";

async function segmentsOrFail(ctx: BlockContext): Promise<Segment[]> {
  const segs = await ctx.store.segments(ctx.data.app.id, sourceIds(ctx));
  if (!segs.length) throw new AppError("VALIDATION", "没有已解析的原始资料，请先在「需求 → 原始资料」上传");
  return segs;
}

// ---------- B01 资料导入：智能体标注（上传、解析、写段落在资料接口中分阶段完成） ----------
const annotateSchema = z.object({ items: z.array(z.object({ n: z.number().int(), speaker: z.string().max(50).nullable().optional(), topic: z.string().max(60), kind: z.enum(["conclusion", "todo", "discussion", "question"]) })) });
const B01: Block = {
  key: "B01", name: "资料导入", taskTier: "fast", agentRole: "资料整理员",
  async chunk(ctx, seq) {
    const segs = await segmentsOrFail(ctx);
    if (ctx.options["annotate"] === false) return { payload: { tags: [], total: segs.length, skipped: true }, more: false, progress: `简化档：跳过智能体标注（${segs.length} 段）` };
    const size = 15; const part = segs.slice(seq * size, seq * size + size);
    if (!part.length) return { payload: { tags: [] }, more: false, progress: "标注完成" };
    const r = await ctx.llm.json(this.taskTier, annotateSchema, [
      { role: "system", content: "你是资料整理员。为每个编号段落标注发言人（无法判断则为 null）、议题（不超过 12 个字）和类型：conclusion 结论 / todo 待办 / discussion 讨论 / question 问题。" },
      { role: "user", content: `输出 {"items":[{"n":编号,"speaker":...,"topic":...,"kind":...}]}\n\n${part.map((s, i) => segLine(s, i + 1)).join("\n")}` },
    ], 2048);
    const tags = r.data.items.flatMap((it) => {
      const s = part[it.n - 1];
      return s ? [{ segment_id: s.id, speaker: s.speaker ? null : it.speaker ?? null, tags: { topic: it.topic, kind: it.kind } }] : [];
    });
    const done = seq * size + part.length;
    return { payload: { tags, total: segs.length }, more: done < segs.length, progress: `已标注 ${done}/${segs.length} 段`, tokens: r.usage.total_tokens, calls: r.calls };
  },
  finalize(ctx, payloads) {
    const tags = payloads.flatMap((p) => (p["tags"] as unknown[]) ?? []);
    const total = Number(payloads[0]?.["total"] ?? 0);
    const skipped = payloads[0]?.["skipped"] === true;
    const topics = Array.from(new Set(tags.map((t) => ((t as { tags: { topic: string } }).tags.topic)))).slice(0, 30);
    return {
      result: { tags, artifact: { type: "source_segments", key: "main", title: "资料段落与标注", agent_role: this.agentRole, confidence: skipped ? null : 0.7,
        content: `# 资料段落与标注\n\n- 段落数：${total}\n- 已标注：${tags.length}${skipped ? "（简化档跳过标注）" : ""}\n\n## 议题\n${topics.map((t) => `- ${t}`).join("\n") || "- 无"}\n` } },
      summary: skipped ? `共 ${total} 段，简化档未做智能体标注` : `共 ${total} 段，已标注 ${tags.length} 段，识别 ${topics.length} 个议题`,
    };
  },
};

// ---------- B02 需求整理 ----------
const reqSchema = z.object({ requirements: z.array(z.object({
  title: z.string().min(2).max(120), story: z.string().max(2000), type: z.enum(["functional", "non_functional"]).default("functional"),
  priority: z.enum(["must", "should", "could", "wont"]).default("should"), confidence: z.number().min(0).max(1),
  citations: z.array(z.number().int()).min(1), criteria: z.array(z.object({ format: z.enum(["ears", "gwt"]), text: z.string().min(4).max(1000) })).min(1),
})) });
type ReqOut = { title: string; story: string; type: string; priority: string; confidence: number; citations: { segment_id: string; source_code: string; seq: number }[]; criteria: { format: string; text: string }[] };
const B02: Block = {
  key: "B02", name: "需求整理", taskTier: "standard", agentRole: "需求分析师",
  async chunk(ctx, seq) {
    const segs = await segmentsOrFail(ctx);
    const size = 10; const part = segs.slice(seq * size, seq * size + size);
    if (!part.length) return { payload: { requirements: [] }, more: false, progress: "整理完成" };
    const existing = seq === 0 ? await ctx.store.requirements(ctx.data.app.id) : [];
    const r = await ctx.llm.json(this.taskTier, reqSchema, [
      { role: "system", content: "你是需求分析师。只根据给定段落整理用户需求，不要编造。每条需求必须引用至少 1 个段落编号（citations），并给出至少 1 条验收标准（EARS 或 Given/When/Then 格式）。没有需求时返回空数组。" + feedbackNote(ctx) },
      { role: "user", content: `${existing.length ? `已有需求标题（相同需求请使用相同标题以便生成新版本）：${existing.map((x) => x.title).join("；")}\n\n` : ""}输出 {"requirements":[{"title","story","type":"functional|non_functional","priority":"must|should|could|wont","confidence":0到1,"citations":[段落编号],"criteria":[{"format":"ears|gwt","text"}]}]}\n\n段落：\n${part.map((s, i) => segLine(s, i + 1)).join("\n")}` },
    ]);
    const requirements: ReqOut[] = r.data.requirements.map((q) => ({ ...q, citations: q.citations.flatMap((n) => { const s = part[n - 1]; return s ? [{ segment_id: s.id, source_code: s.source_code, seq: s.seq }] : []; }) }));
    const done = seq * size + part.length;
    return { payload: { requirements }, more: done < segs.length, progress: `已整理 ${done}/${segs.length} 段`, tokens: r.usage.total_tokens, calls: r.calls };
  },
  finalize(ctx, payloads) {
    const merged = new Map<string, ReqOut>();
    for (const q of payloads.flatMap((p) => (p["requirements"] as ReqOut[]) ?? [])) {
      if (!q.citations.length || !q.criteria.length) continue;
      const k = q.title.trim().toLowerCase(); const prev = merged.get(k);
      if (prev) { prev.citations.push(...q.citations.filter((c) => !prev.citations.some((p) => p.segment_id === c.segment_id))); prev.confidence = Math.min(prev.confidence, q.confidence); }
      else merged.set(k, { ...q, citations: [...q.citations] });
    }
    const list = [...merged.values()];
    if (!list.length) throw new AppError("VALIDATION", "未能从资料中整理出带出处的需求");
    const avg = list.reduce((a, b) => a + b.confidence, 0) / list.length;
    return {
      result: { requirements: list, artifact: { type: "requirements", key: "main", title: "需求清单", agent_role: this.agentRole, confidence: Number(avg.toFixed(2)),
        citations: list.flatMap((q) => q.citations).slice(0, 200),
        content: `# 需求清单\n\n下列标题会在保存后换成需求库中的正式编号。需求分析报告使用同一套编号。\n\n${list.map((q, i) => `## ${i + 1}. ${q.title}\n\n${q.story}\n\n- 优先级：${q.priority}；置信度：${q.confidence}\n- 出处：${q.citations.map((c) => `${c.source_code}#${c.seq}`).join("、")}\n\n验收标准：\n${q.criteria.map((c) => `- [${c.format.toUpperCase()}] ${c.text}`).join("\n")}`).join("\n\n")}\n` } },
      summary: `整理出 ${list.length} 条需求，平均置信度 ${avg.toFixed(2)}`,
    };
  },
};

// ---------- B03 需求分析 ----------
const findingSchema = z.object({ findings: z.array(z.object({ severity: z.enum(["blocker", "major", "minor"]), category: z.enum(["conflict", "duplicate", "missing", "feasibility", "ambiguity"]), refs: z.array(z.string()).default([]), description: z.string().max(2000), suggestion: z.string().max(2000).default("") })).max(40) });
export function ruleFindings(reqs: Requirement[]) {
  const out: { severity: string; category: string; target_refs: { type: string; id: string }[]; description: string; suggestion: string; rule_or_agent: string }[] = [];
  for (const r of reqs) {
    if (!r.criteria.length) out.push({ severity: "major", category: "missing_ac", target_refs: [{ type: "requirement", id: r.id }], description: `${r.code} 没有验收标准`, suggestion: "补充 EARS 或 GWT 格式的验收标准", rule_or_agent: "rule" });
    const text = [r.story, ...r.criteria.map((c) => c.text)].join(" ");
    const hit = VAGUE_WORDS.filter((w) => text.includes(w));
    if (hit.length) out.push({ severity: "minor", category: "vague", target_refs: [{ type: "requirement", id: r.id }], description: `${r.code} 含有含糊用语：${hit.join("、")}`, suggestion: "改为可度量的描述", rule_or_agent: "rule" });
  }
  return out;
}
const reqList = (reqs: Requirement[]) => reqs.map((r) => `${r.code}｜${r.title}｜${r.priority}\n${r.story}\n验收：${r.criteria.map((c) => c.text).join("；")}`).join("\n\n");
const B03: Block = {
  key: "B03", name: "需求分析", taskTier: "standard", agentRole: "需求评审员",
  async chunk(ctx) {
    const reqs = await ctx.store.requirements(ctx.data.app.id);
    if (!reqs.length) throw new AppError("VALIDATION", "没有可分析的需求");
    const byCode = new Map(reqs.map((r) => [r.code, r.id]));
    const blockersOnly = ctx.options["blockers_only"] === true;
    const r = await ctx.llm.json(this.taskTier, findingSchema, [
      { role: "system", content: `你是需求评审员。检查需求之间的冲突、重复、遗漏、可开发性和含糊之处。${blockersOnly ? "只报告会阻断开发的问题（severity=blocker）。" : "按 blocker/major/minor 分级。"}refs 必须使用下面列出的需求编号，禁止编造编号。description 里不要再写需求编号。` + feedbackNote(ctx) },
      { role: "user", content: `输出 {"findings":[{"severity","category":"conflict|duplicate|missing|feasibility|ambiguity","refs":["REQ-0001"],"description","suggestion"}]}，最多 20 条，每条描述不超过 120 字。refs 只能从下列正式编号里选。\n\n${reqList(reqs)}` },
    ], 8192);
    const agent = r.data.findings.filter((f) => !blockersOnly || f.severity === "blocker").map((f) => ({
      severity: f.severity, category: f.category, description: f.description, suggestion: f.suggestion, rule_or_agent: "agent",
      target_refs: f.refs.flatMap((c) => byCode.get(c) ? [{ type: "requirement", id: byCode.get(c)! }] : []),
    }));
    const catalog: ReportReq[] = reqs.map((req) => ({ id: req.id, code: req.code, title: req.title, priority: req.priority }));
    return { payload: { findings: [...ruleFindings(reqs), ...agent], catalog, requirements: reqs.length }, more: false, progress: "分析完成", tokens: r.usage.total_tokens, calls: r.calls };
  },
  finalize(_ctx, payloads) {
    const findings = (payloads[0]?.["findings"] as ReportFinding[]) ?? [];
    const catalog = (payloads[0]?.["catalog"] as ReportReq[]) ?? [];
    const count = (s: string) => findings.filter((f) => f.severity === s).length;
    return {
      result: { findings, artifact: { type: "analysis", key: "main", title: "需求分析报告", agent_role: this.agentRole, confidence: 0.7,
        content: analysisReportMarkdown(findings, catalog) } },
      summary: `发现阻断 ${count("blocker")} 项、重要 ${count("major")} 项、建议 ${count("minor")} 项`,
    };
  },
};

// ---------- B04 澄清问题 ----------
const qSchema = z.object({ questions: z.array(z.object({ stakeholder: z.string().min(1).max(100), contact_name: z.string().max(100).nullable().optional(), question: z.string().min(4).max(2000), refs: z.array(z.string()).default([]) })).max(30) });
const B04: Block = {
  key: "B04", name: "澄清问题", taskTier: "standard", agentRole: "业务沟通员",
  async chunk(ctx) {
    const [reqs, findings, contacts] = await Promise.all([ctx.store.requirements(ctx.data.app.id), ctx.store.openFindings(ctx.data.app.id), ctx.store.contacts(ctx.data.app.id)]);
    if (!reqs.length) throw new AppError("VALIDATION", "没有可澄清的需求");
    const ids = new Map<string, { type: string; id: string }>([...reqs.map((r) => [r.code, { type: "requirement", id: r.id }] as const), ...findings.map((f) => [f.code, { type: "finding", id: f.id }] as const)]);
    const r = await ctx.llm.json(this.taskTier, qSchema, [
      { role: "system", content: "你是业务沟通员。针对需求和分析问题中不明确的地方，生成需要向业务方确认的问题，按提问对象分组。每个问题必须关联至少 1 个需求编号或问题编号。最多 15 个问题，每个问题不超过 80 字。" + feedbackNote(ctx) },
      { role: "user", content: `可提问的联系人：${contacts.map((c) => `${c.name}（${c.title}）`).join("、") || "无"}\n输出 {"questions":[{"stakeholder":"对象角色","contact_name":"联系人姓名或 null","question","refs":["REQ-0001","F-0001"]}]}\n\n需求：\n${reqList(reqs)}\n\n分析问题：\n${findings.map((f) => `${f.code}｜${f.severity}｜${f.description.slice(0, 200)}`).join("\n") || "无"}` },
    ], 8192);
    const questions = r.data.questions.map((q) => ({ stakeholder: q.stakeholder, question: q.question,
      contact_id: contacts.find((c) => q.contact_name && c.name === q.contact_name)?.id ?? null,
      target_refs: q.refs.flatMap((c) => ids.get(c) ? [ids.get(c)!] : []) })).filter((q) => q.target_refs.length);
    return { payload: { questions }, more: false, progress: "问题已生成", tokens: r.usage.total_tokens, calls: r.calls };
  },
  finalize(_ctx, payloads) {
    const questions = (payloads[0]?.["questions"] as { stakeholder: string; question: string }[]) ?? [];
    const groups = new Map<string, string[]>();
    for (const q of questions) groups.set(q.stakeholder, [...(groups.get(q.stakeholder) ?? []), q.question]);
    return {
      result: { questions, artifact: { type: "clarifications", key: "main", title: "澄清问题清单", agent_role: this.agentRole, confidence: 0.7,
        content: `# 澄清问题清单\n\n${[...groups].map(([k, v]) => `## ${k}\n${v.map((x) => `- ${x}`).join("\n")}`).join("\n\n")}\n` } },
      summary: `生成 ${questions.length} 个澄清问题，涉及 ${groups.size} 类对象`,
    };
  },
};

export const BLOCKS: Record<string, Block> = { B01, B02, B03, B04, ...BATCH3, ...BATCH4, ...BATCH5, ...BATCH6, ...BATCH7, ...BATCH8 };
export const IMPLEMENTED_BLOCKS = ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08", "B09", "B10", "B11", "B12", "B13", "B14", "B15", "B16", "B17", "B18", "B19", "B20", "B21", "B22", "B23", "B24", "B26", "B28", "B29", "B30", "B31", "B32", "B33"];
