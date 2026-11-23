// 交接、代码库概况、报告导入和交付检查。交付检查不调用模型。
import type { Block } from "./index";
import { AppError } from "../errors";

const B15: Block = {
  key: "B15", name: "交给开发", taskTier: "fast", agentRole: "lead",
  async chunk(ctx) {
    const saved = await ctx.store.publishHandoff(ctx.data.app.id, ctx.data.run.id, ctx.data.run.code);
    return { payload: saved, more: false, progress: saved.summary };
  },
  finalize(_ctx, payloads) {
    const saved = payloads[0] as { summary?: string } | undefined;
    return { result: { wait_event: "handoff.all_collected" }, summary: saved?.summary ?? "交接包已提交，等待合并请求" };
  },
};

const B16: Block = {
  key: "B16", name: "代码库概况", taskTier: "standard", agentRole: "architect",
  async chunk(ctx) {
    const snap = await ctx.store.repoSnapshot(ctx.data.app.id);
    const listing = snap.files.map((file) => `## ${file.path}\n${file.content.slice(0, 1500)}`).join("\n\n").slice(0, 12000);
    let text = listing || "仓库里没有读到说明文件。";
    let tokens = 0;
    try {
      const reply = await ctx.llm.complete(this.taskTier, [
        { role: "system", content: "你是架构师。只根据给出的文件，用中文写模块职责、数据表和接口的对应关系。不要编造没有出现的文件。" },
        { role: "user", content: listing || "没有文件" },
      ], 1200);
      text = reply.content;
      tokens = reply.usage.total_tokens;
    } catch (error) {
      if (error instanceof AppError && error.code === "LLM_SENSITIVE_FORBIDDEN") throw error;
    }
    return { payload: { text, tokens }, more: false, progress: "已生成代码库概况", tokens, calls: tokens ? 1 : 0 };
  },
  finalize() {
    return { result: {}, summary: "代码库概况已生成" };
  },
};

const B20: Block = {
  key: "B20", name: "报告导入", taskTier: "standard", agentRole: "qa",
  async chunk(ctx) {
    const failed = await ctx.store.failedTests(ctx.data.app.id);
    let advice = failed.length ? "" : "没有失败用例。";
    let tokens = 0;
    if (failed.length) {
      try {
        const reply = await ctx.llm.complete(this.taskTier, [
          { role: "system", content: "你是测试负责人。根据失败用例给出可能原因和修复建议，不要断言没有给出的日志。" },
          { role: "user", content: failed.map((item) => `${item.ac_code ?? "无验收标准"} ${item.name}`).join("\n") },
        ], 800);
        advice = reply.content;
        tokens = reply.usage.total_tokens;
      } catch (error) {
        if (error instanceof AppError && error.code === "LLM_SENSITIVE_FORBIDDEN") throw error;
        advice = `有 ${failed.length} 个失败用例。模型暂时不能生成说明。`;
      }
    }
    return { payload: { advice, failed: failed.length, tokens }, more: false, progress: failed.length ? `${failed.length} 个失败用例` : "报告里没有失败用例", tokens, calls: tokens ? 1 : 0 };
  },
  finalize(_ctx, payloads) {
    const advice = String(payloads[0]?.["advice"] ?? "");
    return {
      result: { artifact: { type: "report_summary", key: "main", title: "测试报告摘要", agent_role: "qa", content: advice } },
      summary: advice.slice(0, 180) || "报告已汇总",
    };
  },
};

const B21: Block = {
  key: "B21", name: "交付检查", taskTier: "fast", agentRole: "qa",
  async chunk(ctx) {
    const gate = await ctx.store.saveGate(ctx.data.app.id, ctx.data.run.id);
    const lines = gate.items.map((item) => `${item.item_key} ${item.status} ${item.evidence}`).join("\n");
    return { payload: { met: gate.met, lines }, more: false, progress: gate.met ? "满足交付条件" : "未满足交付条件" };
  },
  finalize(_ctx, payloads) {
    const lines = String(payloads[0]?.["lines"] ?? "");
    const met = Boolean(payloads[0]?.["met"]);
    return {
      result: { artifact: { type: "delivery_gate", key: "main", title: "交付检查", agent_role: "qa", content: lines } },
      summary: met ? "满足交付条件" : "未满足交付条件",
    };
  },
};

B16.finalize = function finalize(_ctx, payloads) {
  const text = String(payloads[0]?.["text"] ?? "");
  return {
    result: { artifact: { type: "repo_summary", key: "main", title: "代码库概况", agent_role: "architect", content: text } },
    summary: "代码库概况已生成",
  };
};

export const BATCH4 = { B15, B16, B20, B21 };
