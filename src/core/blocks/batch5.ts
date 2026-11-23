// 上线后的反馈分类、变更说明、业务确认、验收和发布。业务说明不出现表名和接口名。
import { AppError } from "../errors";
import type { Block } from "./index";

const B31: Block = {
  key: "B31", name: "反馈分类", taskTier: "fast", agentRole: "ba",
  async chunk(ctx) {
    const id = String(ctx.data.run.inputs["feedback_id"] ?? "");
    if (!id) return { payload: { skipped: true }, more: false, progress: "没有待分类的反馈" };
    await ctx.store.triageFeedback(ctx.data.app.id, id);
    return { payload: { feedback_id: id }, more: false, progress: "已给出分类建议" };
  },
  finalize(_ctx, payloads) {
    return { result: {}, summary: payloads[0]?.["skipped"] ? "没有新的反馈" : "反馈已分类" };
  },
};

const B05: Block = {
  key: "B05", name: "变更方案", taskTier: "standard", agentRole: "ba",
  async chunk(ctx) {
    const change = await ctx.store.loadChange(String(ctx.data.run.inputs["change_request_id"] ?? ""));
    if (!change) throw new AppError("VALIDATION", "请从变更请求启动功能增强");
    const draft = ctx.store.plainSummary(change.title, change.requirement_codes);
    let business = draft.business;
    let technical = draft.technical;
    const note = ctx.feedback ? `上次退回意见：${ctx.feedback}` : "";
    try {
      const reply = await ctx.llm.complete(this.taskTier, [
        { role: "system", content: "你是业务分析师。输出两段中文，用「业务说明：」和「技术说明：」分开。业务说明给门店和业务同事看，不要出现表名、接口、字段、框架。技术说明写受影响的需求和验收。" },
        { role: "user", content: `变更 ${change.code} ${change.title}\n相关需求 ${change.requirement_codes.join("、") || "未指定"}\n${note}` },
      ], 700);
      const text = reply.content;
      const biz = /业务说明：([\s\S]*?)(?:技术说明：|$)/.exec(text)?.[1]?.trim();
      const tech = /技术说明：([\s\S]*)/.exec(text)?.[1]?.trim();
      if (biz) business = biz;
      if (tech) technical = tech;
    } catch (error) {
      if (error instanceof AppError && error.code === "LLM_SENSITIVE_FORBIDDEN") throw error;
    }
    await ctx.store.saveChangeSummary(ctx.data.app.id, change.id, business, technical);
    return { payload: { business }, more: false, progress: "已写好给业务看的说明" };
  },
  finalize(_ctx, payloads) {
    return {
      result: { artifact: { type: "business_summary", key: "main", title: "这次改什么", agent_role: "ba", content: String(payloads[0]?.["business"] ?? "") } },
      summary: "变更说明已交给业务确认",
    };
  },
};

const B32: Block = {
  key: "B32", name: "业务确认", taskTier: "fast", agentRole: "ba",
  async chunk(ctx) {
    const change = await ctx.store.loadChange(String(ctx.data.run.inputs["change_request_id"] ?? ""));
    const agenda = await ctx.store.meetingAgenda(ctx.data.app.id);
    return { payload: { summary: change?.business_summary ?? "", agenda }, more: false, progress: "已推送到业务门户" };
  },
  finalize(_ctx, payloads) {
    return { result: { artifact: { type: "meeting_agenda", key: "main", title: "业务沟通会议程", agent_role: "ba", content: String(payloads[0]?.["agenda"] ?? "") } }, summary: "等待业务确认" };
  },
};

const B33: Block = {
  key: "B33", name: "业务验收", taskTier: "fast", agentRole: "qa",
  async chunk(ctx) {
    const count = await ctx.store.createUat(
      ctx.data.app.id,
      String(ctx.data.run.inputs["change_request_id"] ?? "") || null,
      String(ctx.data.run.inputs["iteration_id"] ?? "") || null,
    );
    return { payload: { count }, more: false, progress: count ? `已列出 ${count} 项验收` : "这次没有可点按的验收项" };
  },
  finalize(_ctx, payloads) {
    return { result: {}, summary: `验收清单 ${payloads[0]?.["count"] ?? 0} 项` };
  },
};

const B24: Block = {
  key: "B24", name: "发布说明", taskTier: "standard", agentRole: "lead",
  async chunk(ctx) {
    const version = String(ctx.data.run.inputs["version"] ?? "v1.2");
    const change = await ctx.store.loadChange(String(ctx.data.run.inputs["change_request_id"] ?? ""));
    let business = change ? `这一版上线了「${change.title}」。页面会按确认过的说法变化，其他功能保持原样。` : `${version} 已发布。`;
    const technical = change ? `发布 ${version}，包含变更 ${change.code}。` : `发布 ${version}。`;
    try {
      const reply = await ctx.llm.complete(this.taskTier, [
        { role: "system", content: "用一句中文写给业务同事的发布说明，不要出现表名、接口和框架。" },
        { role: "user", content: business },
      ], 240);
      if (reply.content.trim()) business = reply.content.trim();
    } catch (error) {
      if (error instanceof AppError && error.code === "LLM_SENSITIVE_FORBIDDEN") throw error;
    }
    await ctx.store.publishRelease(ctx.data.app.id, version, ctx.data.run.started_by, { business, technical }, change?.iteration_id ?? null);
    return { payload: { business, version }, more: false, progress: `${version} 已发布` };
  },
  finalize(_ctx, payloads) {
    return {
      result: { artifact: { type: "notes_business", key: String(payloads[0]?.["version"] ?? "v1.2"), title: "这一版改了什么", agent_role: "lead", content: String(payloads[0]?.["business"] ?? "") } },
      summary: `${payloads[0]?.["version"] ?? ""} 已发布`,
    };
  },
};

export const BATCH5 = { B31, B05, B32, B33, B24 };
