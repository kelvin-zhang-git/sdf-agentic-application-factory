// 阶段 8：代码评审把意见写回合并请求；交付流度量的数字由查询算出，模型只写说明。
import { AppError } from "../errors";
import type { Block } from "./index";

const B17: Block = {
  key: "B17", name: "代码评审助手", taskTier: "standard", agentRole: "architect",
  async chunk(ctx) {
    const material = await ctx.store.reviewTargets(ctx.data.app.id);
    const comments: { number: number; title: string; body: string }[] = [];
    for (const pull of material.pulls) {
      let body = `SDF 代码评审\n合并请求 #${pull.number} ${pull.title}\n差异约 ${pull.diff.length} 字。请对照工程规范和验收标准人工看一遍。`;
      try {
        const reply = await ctx.llm.complete("standard", [
          { role: "system", content: "你是代码评审助手。只根据给出的差异、工程规范和验收标准写评审意见。指出可能违反规范或没有覆盖验收标准的地方。不要编造没有出现的文件，不要输出密钥。用中文，不超过 800 字。" },
          { role: "user", content: `工程规范：\n${material.constitution.slice(0, 2000) || "还没有工程规范"}\n\n验收标准：\n${material.criteria.slice(0, 2000) || "还没有验收标准"}\n\n差异：\n${pull.diff || "没有差异正文"}` },
        ], 900);
        if (reply.content.trim()) body = reply.content.trim().slice(0, 3500);
      } catch (error) {
        if (error instanceof AppError && error.code === "LLM_SENSITIVE_FORBIDDEN") throw error;
      }
      await ctx.store.commentOnPull(ctx.data.app.id, pull.number, body);
      comments.push({ number: pull.number, title: pull.title, body });
    }
    const markdown = [
      "# 代码评审",
      "",
      material.pulls.length ? `已处理 ${comments.length} 个打开的合并请求。` : "没有打开的合并请求，本次只保留对照材料。",
      "",
      "## 工程规范摘录",
      material.constitution.slice(0, 800) || "还没有工程规范。",
      "",
      "## 验收标准摘录",
      material.criteria.slice(0, 800) || "还没有验收标准。",
      "",
      ...comments.map((item) => `## #${item.number} ${item.title}\n\n${item.body}`),
    ].join("\n");
    return { payload: { markdown, count: comments.length }, more: false, progress: comments.length ? `已评论 ${comments.length} 个合并请求` : "没有打开的合并请求" };
  },
  finalize(_ctx, payloads) {
    const markdown = String(payloads[0]?.["markdown"] ?? "");
    const count = Number(payloads[0]?.["count"] ?? 0);
    return {
      result: { artifact: { type: "review_note", key: "main", title: "代码评审意见", agent_role: "architect", confidence: 0.6, content: markdown } },
      summary: count ? `已把评审意见写回 ${count} 个合并请求` : "没有打开的合并请求",
    };
  },
};

const B30: Block = {
  key: "B30", name: "交付流度量", taskTier: "fast", agentRole: "business_analyst",
  async chunk(ctx) {
    const metrics = await ctx.store.flowMetrics(ctx.data.app.id);
    const coverage = metrics.requirements ? Math.round((metrics.covered_requirements / metrics.requirements) * 1000) / 10 : 0;
    const adoption = metrics.decided ? Math.round((metrics.approved / metrics.decided) * 1000) / 10 : 0;
    const stageLines = metrics.stages.length
      ? metrics.stages.map((item) => `- ${item.stage}：${item.hours} 小时（样本量 ${item.samples}）`).join("\n")
      : "- 还没有已完成的步骤";
    const facts = [
      `# 交付流度量`,
      "",
      "口径：周期时间是已完成运行从开始到结束的平均小时数。阶段停留是已成功步骤的平均小时数。需求覆盖是有测试用例的需求占未废弃需求的比例。确认采纳是人工确认通过的步骤占已做确认的步骤的比例。",
      "",
      `- 周期时间：${metrics.cycle_hours ?? "无"} 小时（样本量 ${metrics.cycle_samples}）`,
      `- 需求覆盖：${coverage}%（${metrics.covered_requirements}/${metrics.requirements}）`,
      `- 确认采纳：${adoption}%（${metrics.approved}/${metrics.decided}）`,
      "",
      "## 阶段停留",
      stageLines,
    ].join("\n");
    let note = "数字来自平台记录，没有让模型改写。";
    try {
      const reply = await ctx.llm.complete("fast", [
        { role: "system", content: "你是交付负责人。根据给出的指标写一段不超过 150 字的周报说明。不要改动数字，不要编造没有给出的样本量。" },
        { role: "user", content: facts },
      ], 400);
      if (reply.content.trim()) note = reply.content.trim().slice(0, 500);
    } catch (error) {
      if (error instanceof AppError && error.code === "LLM_SENSITIVE_FORBIDDEN") throw error;
    }
    return { payload: { markdown: `${facts}\n\n## 说明\n\n${note}\n`, metrics }, more: false, progress: `周期样本 ${metrics.cycle_samples}，确认样本 ${metrics.decided}` };
  },
  finalize(_ctx, payloads) {
    const markdown = String(payloads[0]?.["markdown"] ?? "");
    return {
      result: { artifact: { type: "flow_metrics", key: "main", title: "交付流度量", agent_role: "business_analyst", confidence: 1, content: markdown, content_json: payloads[0]?.["metrics"] ?? {} } },
      summary: "已按平台记录计算交付流指标",
    };
  },
};

export const BATCH8: Record<string, Block> = { B17, B30 };
