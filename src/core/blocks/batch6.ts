// 阶段 5：方案草图、优先级、测试脚本、部署包。主体用已有制品拼出来，模型不可用时仍能交付。
import { AppError } from "../errors";
import type { Requirement } from "../engine/types";
import type { Block, BlockContext } from "./index";

const RANK: Record<string, number> = { must: 1, should: 2, could: 3, wont: 4 };
const RANK_LABEL: Record<string, string> = { must: "必须", should: "应该", could: "可以", wont: "暂不" };

function ordered(reqs: Requirement[]): Requirement[] {
  return [...reqs].sort((a, b) => (RANK[a.priority] ?? 9) - (RANK[b.priority] ?? 9) || a.code.localeCompare(b.code));
}

function markdownTable(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function entitiesFrom(content: string, contentJson: unknown): string[] {
  const bag = contentJson && typeof contentJson === "object" ? contentJson as { entities?: { name?: string }[] } : null;
  const fromJson = (bag?.entities ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  if (fromJson.length) return fromJson.slice(0, 12);
  try {
    const parsed = JSON.parse(content) as { entities?: { name?: string }[] };
    return (parsed.entities ?? []).map((item) => item.name).filter((name): name is string => Boolean(name)).slice(0, 12);
  } catch {
    return [];
  }
}

const B07: Block = {
  key: "B07", name: "优先级", taskTier: "fast", agentRole: "business_analyst",
  async chunk(ctx) {
    const reqs = ordered(await ctx.store.requirements(ctx.data.app.id));
    if (!reqs.length) return { payload: { markdown: "还没有需求，无法排序。" }, more: false, progress: "没有需求" };
    let reason = "按 MoSCoW 排序：必须、应该、可以、暂不。同档按编号。";
    try {
      const reply = await ctx.llm.complete("fast", [
        { role: "system", content: "你是业务分析师。用两三句中文说明这个排序是否合理。不要改编号，不要输出密钥。" },
        { role: "user", content: reqs.map((item) => `${item.code} ${RANK_LABEL[item.priority] ?? item.priority} ${item.title}`).join("\n") },
      ], 400);
      if (reply.content.trim()) reason = reply.content.trim().slice(0, 500);
    } catch (error) {
      if (error instanceof AppError && error.code === "LLM_SENSITIVE_FORBIDDEN") throw error;
    }
    const rows = reqs.map((item, index) => [String(index + 1), item.code, RANK_LABEL[item.priority] ?? item.priority, item.title]);
    const markdown = `# 需求优先级\n\n${reason}\n\n${markdownTable(["顺序", "编号", "档位", "标题"], rows)}\n`;
    return { payload: { markdown }, more: false, progress: `已排列 ${reqs.length} 条需求` };
  },
  finalize(_ctx, payloads) {
    const markdown = String(payloads[0]?.["markdown"] ?? "");
    return {
      result: { artifact: { type: "priority_list", key: "main", title: "需求优先级", agent_role: "business_analyst", confidence: 0.8, content: markdown } },
      summary: markdown.includes("没有需求") ? "没有需求可排序" : "已按 MoSCoW 排出优先级",
    };
  },
};

const B06: Block = {
  key: "B06", name: "方案草图", taskTier: "standard", agentRole: "business_analyst",
  async chunk(ctx) {
    const reqs = ordered(await ctx.store.requirements(ctx.data.app.id));
    const model = await ctx.store.latestArtifact(ctx.data.app.id, "data_model");
    const entities = entitiesFrom(model?.content ?? "", model?.content_json);
    const flow = ["flowchart TD"];
    const shown = reqs.slice(0, 8);
    if (!shown.length) flow.push('  empty["还没有需求"]');
    shown.forEach((item, index) => flow.push(`  R${index}["${item.code} ${item.title.replace(/["\n\r]/g, " ").slice(0, 18)}"]`));
    for (let index = 1; index < shown.length; index += 1) flow.push(`  R${index - 1} --> R${index}`);
    const named = entities.map((name, index) => ({ name: name.replace(/["\n\r]/g, " "), id: `E${index + 1}` }));
    const er = named.length
      ? ["erDiagram", ...named.map((item) => `  ${item.id} { string id }`)]
      : ["erDiagram", "  E1 { string id }"];
    const entityList = named.length ? named.map((item) => `- ${item.id}：${item.name}`).join("\n") : "- 还没有数据模型，下面只放一个占位实体";
    const matrix = markdownTable(
      ["角色", ...reqs.slice(0, 6).map((item) => item.code)],
      [["业务方", ...reqs.slice(0, 6).map((item) => (item.priority === "must" ? "主责" : "知情"))], ["交付", ...reqs.slice(0, 6).map(() => "实现")]],
    );
    const markdown = `# 方案草图\n\n## 角色与需求\n\n${matrix || "还没有需求。"}\n\n## 业务流程\n\n\`\`\`mermaid\n${flow.join("\n")}\n\`\`\`\n\n## 实体草图\n\n${entityList}\n\n\`\`\`mermaid\n${er.join("\n")}\n\`\`\`\n`;
    return { payload: { markdown }, more: false, progress: `草图覆盖 ${reqs.length} 条需求、${entities.length} 个实体` };
  },
  finalize(_ctx, payloads) {
    return {
      result: { artifact: { type: "solution_sketch", key: "main", title: "方案草图", agent_role: "business_analyst", confidence: 0.7, content: String(payloads[0]?.["markdown"] ?? "") } },
      summary: "已生成角色矩阵、流程和实体草图",
    };
  },
};

function scriptFor(reqs: Requirement[]): string {
  const cases = reqs.flatMap((item) => item.criteria.slice(0, 2).map((criterion) => ({ code: item.code, ac: criterion.code ?? "AC", text: criterion.text })));
  const body = cases.slice(0, 20).map((item, index) => [
    `def test_${index + 1}_${item.code.toLowerCase().replace(/[^a-z0-9]+/g, "_")}():`,
    `    """${item.code} ${item.ac}：${item.text.replace(/["\n\r]/g, " ").slice(0, 80)}"""`,
    '    pytest.skip("待接入被测系统后补充真实断言")',
    "",
  ].join("\n"));
  const fallback = 'def test_placeholder():\n    pytest.skip("还没有需求，待补充真实断言")\n';
  return `# 由验收标准生成的测试脚本骨架。默认跳过以避免虚假通过，接入真实系统后请替换为断言。\nimport pytest\n\n${body.join("\n") || fallback}`;
}

const B19: Block = {
  key: "B19", name: "测试脚本", taskTier: "fast", agentRole: "test_designer",
  async chunk(ctx) {
    const reqs = await ctx.store.requirements(ctx.data.app.id);
    const pytest = scriptFor(reqs);
    const playwright = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('主路径可以打开', async ({ page }) => {",
      "  test.skip(!process.env.BASE_URL, '请配置 BASE_URL 并补充业务断言后执行');",
      "  await page.goto(process.env.BASE_URL || '/');",
      "  await expect(page.locator('body')).toBeVisible();",
      "});",
      "",
    ].join("\n");
    return { payload: { pytest, playwright, count: reqs.length }, more: false, progress: reqs.length ? `已为 ${reqs.length} 条需求起草脚本` : "没有需求，只生成页面冒烟脚本" };
  },
  finalize(_ctx, payloads) {
    return {
      result: {
        artifacts: [
          { type: "test_script", key: "pytest", title: "test_acceptance.py", agent_role: "test_designer", confidence: 0.6, content: String(payloads[0]?.["pytest"] ?? "") },
          { type: "test_script", key: "playwright", title: "smoke.spec.ts", agent_role: "test_designer", confidence: 0.6, content: String(payloads[0]?.["playwright"] ?? "") },
        ],
      },
      summary: `已起草测试脚本，覆盖 ${payloads[0]?.["count"] ?? 0} 条需求`,
    };
  },
};

const B23: Block = {
  key: "B23", name: "部署包", taskTier: "fast", agentRole: "architect",
  async chunk(ctx) {
    const slug = ctx.data.app.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "app";
    const dockerfile = [
      "FROM docker.m.daocloud.io/library/node:22-alpine",
      "WORKDIR /app",
      "COPY package.json package-lock.json ./",
      "RUN npm ci --omit=dev",
      "COPY . .",
      "USER node",
      "EXPOSE 3000",
      "CMD [\"npm\", \"start\"]",
      "",
    ].join("\n");
    const compose = [
      `services:`,
      `  ${slug}:`,
      "    build: .",
      "    ports:",
      "      - \"3000:3000\"",
      "    env_file: .env",
      "",
    ].join("\n");
    const envFile = [
      "# 复制为 .env 后再填写。不要把真实口令提交到仓库。",
      "PORT=3000",
      "SDF_PG_HOST=sdf-postgres",
      "SDF_PG_PORT=5432",
      "SDF_PG_DATABASE=sdf",
      "SDF_PG_PASSWORD=",
      "",
    ].join("\n");
    return { payload: { dockerfile, compose, envFile }, more: false, progress: "已生成 Dockerfile、编排和环境变量模板" };
  },
  finalize(_ctx, payloads) {
    return {
      result: {
        artifacts: [
          { type: "deploy_pack", key: "dockerfile", title: "Dockerfile", agent_role: "architect", confidence: 0.8, content: String(payloads[0]?.["dockerfile"] ?? "") },
          { type: "deploy_pack", key: "compose", title: "docker-compose.yml", agent_role: "architect", confidence: 0.8, content: String(payloads[0]?.["compose"] ?? "") },
          { type: "deploy_pack", key: "env", title: ".env.example", agent_role: "architect", confidence: 1, content: String(payloads[0]?.["envFile"] ?? "") },
        ],
      },
      summary: "已生成部署包模板",
    };
  },
};

export const BATCH6: Record<string, Block> = { B06, B07, B19, B23 };
