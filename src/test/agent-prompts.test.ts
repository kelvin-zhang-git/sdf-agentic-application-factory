import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AGENT_ROLE_SPECS, BUSINESS_ANALYST_SYSTEM_PROMPT, resolveRoleKey, ROLE_OF_BLOCK } from "@/core/agents";
import { IMPLEMENTED_BLOCKS } from "@/core/blocks";
import { mergeRolePrompt, OpenAICompatibleGateway } from "@/core/model-gateway";
import type { LlmMessage, LlmProvider, ModelRoute } from "@/core/llm";

const provider: LlmProvider = {
  id: "p1", name: "local", base_url: "http://localhost:4000/v1",
  models: ["m1"], secret_id: "s1", allowed_for_sensitive: true, enabled: true, priority: 1,
};
const route: ModelRoute = { id: "r1", task_tier: "fast", provider_id: "p1", model: "m1", fallback_order: 1 };

describe("十个内置智能体系统提示词与角色注入", () => {
  it("全部 10 个内置角色均具备六段式专业提示词，且覆盖全部 31 个已实施积木", () => {
    expect(AGENT_ROLE_SPECS).toHaveLength(10);
    const keys = new Set(AGENT_ROLE_SPECS.map((item) => item.key));
    expect(keys.size).toBe(10);

    for (const spec of AGENT_ROLE_SPECS) {
      expect(spec.summary.length).toBeGreaterThanOrEqual(20);
      expect(spec.prompt.length).toBeGreaterThanOrEqual(1200);
      expect(spec.prompt.length).toBeLessThanOrEqual(8000);
      expect(spec.prompt).toContain("### 一、角色定位与协同边界");
      expect(spec.prompt).toContain("### 二、核心职责（对应平台积木场景）");
      expect(spec.prompt).toContain("### 三、标准");
      expect(spec.prompt).toContain("### 四、");
      expect(spec.prompt).toContain("### 五、输出契约与格式适配规则（最高优先级）");
      expect(spec.prompt).toContain("### 六、异常边界与安全护栏");
      expect(spec.prompt).not.toContain("配方");
      expect(spec.prompt).not.toContain("门禁");
    }

    for (const blockKey of IMPLEMENTED_BLOCKS) {
      const mapped = resolveRoleKey(blockKey);
      expect(mapped, `${blockKey} 未映射到有效角色`).toBeDefined();
      expect(keys.has(mapped!)).toBe(true);
    }
    expect(resolveRoleKey("requirement_analyst")).toBe("requirement_analyst");
    expect(resolveRoleKey("architect")).toBe("architect");
    expect(resolveRoleKey("unknown_role")).toBeUndefined();
    expect(BUSINESS_ANALYST_SYSTEM_PROMPT).toContain("B05");
    expect(ROLE_OF_BLOCK["B30"]).toBe("business_analyst");
  });

  it("将角色系统提示词与积木任务契约合并为单条前导 system，重试时不重复拼接", async () => {
    const merged = mergeRolePrompt(
      [{ role: "system", content: "只输出两句话" }, { role: "user", content: "REQ-0001" }],
      "你是资深业务分析师",
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.role).toBe("system");
    expect(merged[0]?.content).toContain("你是资深业务分析师");
    expect(merged[0]?.content).toContain("只输出两句话");

    const sent: LlmMessage[][] = [];
    let attempt = 0;
    const gw = new OpenAICompatibleGateway({
      classification: "internal",
      redact: false,
      providers: [provider],
      routes: [route],
      rolePrompt: "你是资深业务分析师",
      apiKey: async () => "k",
      record: async () => undefined,
      fetchImpl: (async (_url, init) => {
        attempt += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages: LlmMessage[] };
        sent.push(body.messages);
        const content = attempt === 1 ? "not-json" : "{\"ok\":true}";
        return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
      }) as typeof fetch,
    });

    const out = await gw.json("fast", z.object({ ok: z.boolean() }), [
      { role: "system", content: "返回 JSON" },
      { role: "user", content: "测试" },
    ]);
    expect(out.data.ok).toBe(true);
    expect(sent).toHaveLength(2);
    const secondSystem = sent[1]?.[0]?.content ?? "";
    expect(secondSystem.split("你是资深业务分析师").length - 1).toBe(1);
  });
});
