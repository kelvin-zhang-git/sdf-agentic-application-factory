// 阶段 6：脚手架、资产包、任务板。结构由模板决定，模型只补充一句说明，失败时仍交付。
import { acceptanceTestSource } from "../acceptance-run";
import { AppError } from "../errors";
import type { Requirement } from "../engine/types";
import type { Block, BlockContext } from "./index";

const STATUS_LABEL: Record<string, string> = { todo: "待办", doing: "进行中", review: "待复核", blocked: "受阻", done: "完成" };

function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "app";
}

function redact(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[已去除]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[已去除]")
    .replace(/(password\s*[:=]\s*)\S+/gi, "$1");
}

function entitiesFrom(content: string, contentJson: unknown): string[] {
  const bag = contentJson && typeof contentJson === "object" ? contentJson as { entities?: { name?: string }[] } : null;
  const fromJson = (bag?.entities ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  if (fromJson.length) return fromJson.slice(0, 20);
  try {
    const parsed = JSON.parse(content) as { entities?: { name?: string }[] };
    return (parsed.entities ?? []).map((item) => item.name).filter((name): name is string => Boolean(name)).slice(0, 20);
  } catch {
    return [];
  }
}

async function note(ctx: BlockContext, fallback: string, source: string): Promise<string> {
  try {
    const reply = await ctx.llm.complete("fast", [
      { role: "system", content: "用一句中文说明这个工程骨架覆盖了什么。不要输出密钥、邮箱或连接串。" },
      { role: "user", content: source.slice(0, 1500) },
    ], 200);
    return redact(reply.content.trim() || fallback).slice(0, 300);
  } catch (error) {
    if (error instanceof AppError && error.code === "LLM_SENSITIVE_FORBIDDEN") throw error;
    return fallback;
  }
}

function genericServerSource(header: string, reqs: Requirement[], entities: string[]): string {
  const reqCodes = reqs.slice(0, 30).map((item) => item.code);
  return [
    header,
    "",
    `export const metadata = ${JSON.stringify({ requirements: reqCodes, entities }, null, 2)};`,
    "",
    "export function start() {",
    "  return { ok: true, requirements: metadata.requirements.length, entities: metadata.entities };",
    "}",
    "",
  ].join("\n");
}

const B13: Block = {
  key: "B13", name: "模板脚手架", taskTier: "fast", agentRole: "architect",
  async chunk(ctx) {
    const reqs = await ctx.store.requirements(ctx.data.app.id);
    const model = await ctx.store.latestArtifact(ctx.data.app.id, "data_model");
    const entities = entitiesFrom(model?.content ?? "", model?.content_json);
    const name = slug(ctx.data.app.name);
    const lines = reqs.slice(0, 30).map((item) => `${item.code} ${item.title}`);
    const summary = await note(ctx, reqs.length ? `骨架覆盖 ${reqs.length} 条需求。` : "还没有需求，骨架只包含空工程。", lines.join("\n"));
    const readme = redact(`# ${ctx.data.app.name}\n\n${summary}\n\n## 需求\n\n${lines.map((line) => `- ${line}`).join("\n") || "- 还没有需求"}\n`);
    const pkg = `${JSON.stringify({ name, private: true, type: "module", scripts: { start: "node src/server.js", test: "node --test" } }, null, 2)}\n`;
    const header = [
      "// 模板生成的通用入口，请按具体业务设计与任务清单补充模块与路由。",
      ...reqs.slice(0, 20).map((item) => `// ${item.code} ${item.title.replace(/[\n\r]/g, " ").slice(0, 40)}`),
      ...entities.map((item) => `// entity ${item.replace(/[\n\r]/g, " ")}`),
    ].join("\n");
    const server = genericServerSource(header, reqs, entities);
    const tests = acceptanceTestSource(reqs.slice(0, 20).map((item) => ({
      name: `${item.criteria.find((criterion) => criterion.code)?.code ?? item.code} ${item.title.replace(/[\n\r"]/g, " ").slice(0, 40)}`,
    })));
    return { payload: { readme, pkg, server, tests, count: reqs.length }, more: false, progress: `已生成 ${reqs.length} 条需求对应的工程骨架` };
  },
  finalize(_ctx, payloads) {
    return {
      result: {
        artifacts: [
          { type: "scaffold", key: "readme", title: "README.md", agent_role: "architect", confidence: 0.8, content: String(payloads[0]?.["readme"] ?? "") },
          { type: "scaffold", key: "package", title: "package.json", agent_role: "architect", confidence: 1, content: String(payloads[0]?.["pkg"] ?? "") },
          { type: "scaffold", key: "server", title: "src/server.js", agent_role: "architect", confidence: 0.7, content: String(payloads[0]?.["server"] ?? "") },
          { type: "scaffold", key: "test", title: "test/acceptance.test.js", agent_role: "architect", confidence: 0.8, content: String(payloads[0]?.["tests"] ?? "") },
        ],
      },
      summary: `已生成工程骨架，覆盖 ${payloads[0]?.["count"] ?? 0} 条需求`,
    };
  },
};

const B28: Block = {
  key: "B28", name: "资产与应用目录", taskTier: "fast", agentRole: "document_writer",
  async chunk(ctx) {
    const reqs = await ctx.store.requirements(ctx.data.app.id);
    const constitution = await ctx.store.latestArtifact(ctx.data.app.id, "constitution");
    const pack = {
      kind: "sdfpack",
      version: 1,
      app: ctx.data.app.name,
      requirements: reqs.map((item: Requirement) => ({ code: item.code, title: item.title })),
      constitution: constitution ? "已有工程规范" : "还没有工程规范",
    };
    const content = redact(JSON.stringify(pack, null, 2));
    return { payload: { content, count: reqs.length }, more: false, progress: "已整理资产包" };
  },
  finalize(_ctx, payloads) {
    return {
      result: { artifact: { type: "asset_pack", key: "main", title: "应用资产包.sdfpack.json", agent_role: "document_writer", confidence: 1, content: String(payloads[0]?.["content"] ?? "") } },
      summary: `已导出资产包，含 ${payloads[0]?.["count"] ?? 0} 条需求`,
    };
  },
};

const B29: Block = {
  key: "B29", name: "轻量任务板", taskTier: "fast", agentRole: "task_planner",
  async chunk(ctx) {
    const tasks = await ctx.store.tasks(ctx.data.app.id);
    const sections = ["todo", "doing", "review", "blocked", "done"].map((status) => {
      const rows = tasks.filter((task) => task.status === status);
      const body = rows.map((task) => `- ${task.code} ${task.title}（${task.assignee_kind === "agent" ? "智能体" : "人"}）`).join("\n");
      return `## ${STATUS_LABEL[status]}\n\n${body || "- 没有任务"}`;
    });
    const markdown = `# 任务板\n\n${sections.join("\n\n")}\n`;
    return { payload: { markdown, count: tasks.length }, more: false, progress: tasks.length ? `看板上有 ${tasks.length} 个任务` : "还没有任务" };
  },
  finalize(_ctx, payloads) {
    return {
      result: { artifact: { type: "task_board", key: "main", title: "任务板", agent_role: "task_planner", confidence: 1, content: String(payloads[0]?.["markdown"] ?? "") } },
      summary: `任务板收录 ${payloads[0]?.["count"] ?? 0} 个任务`,
    };
  },
};

export const BATCH7: Record<string, Block> = { B13, B28, B29 };
