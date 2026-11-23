import { describe, expect, it, vi } from "vitest";
import { redactMessages, redactPii } from "@/core/llm";
import { OpenAICompatibleGateway } from "@/core/model-gateway";
import { BLOCKS, type BlockContext } from "@/core/blocks";
import { formatWaitingHumanNotice } from "@/adapters/engine-store";

function fakeBlockContext(): BlockContext {
  return {
    data: {
      run: { id: "r", code: "RUN-1", weight: "light", inputs: {}, trace_id: "t", started_by: "u", snapshot: { steps: [] } },
      step: { id: "s", run_id: "r", app_id: "a", step_key: "x", block_key: "B13", attempt: 1, cursor_seq: 0, cursor: null, checkpoint: null },
      app: { id: "a", name: "通用报销单系统", classification: "internal", redact_before_llm: false },
    },
    llm: {
      complete: async () => ({ content: "覆盖通用报销单需求。", model: "m", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    } as unknown as BlockContext["llm"],
    store: {
      requirements: async () => [{
        id: "req-1", code: "REQ-0001", title: "提交差旅报销单", story: "员工提交差旅报销单并进入主管审批", type: "functional", priority: "must",
        criteria: [{ code: "AC-0001", format: "given_when_then", text: "金额大于 5000 时需二级审批" }],
      }],
      latestArtifact: async () => ({ content: "", content_json: { entities: [{ name: "expense_claim" }] } }),
      tasks: async () => [],
    } as unknown as BlockContext["store"],
    options: {},
    feedback: null,
  };
}

describe("P1 脱敏规则扩展（VIN / 内网 IP / 自定义词表）", () => {
  it("脱敏 17 位 VIN、RFC1918 内网 IP 和自定义专有词，且不误伤公网 IP", () => {
    const raw = "车架号 LSVAA4182E2184951 在测试台 192.168.0.10 与 10.20.30.40 和 172.16.8.9 上联调，公网 DNS 8.8.8.8，项目 极光智行-E08 联系人 13800138000";
    const out = redactPii(raw, ["极光", "极光智行-E08", "a"]);
    expect(out).toContain("[VIN已脱敏]");
    expect(out).not.toContain("LSVAA4182E2184951");
    expect(out).toContain("[内网IP已脱敏]");
    expect(out).not.toContain("192.168.0.10");
    expect(out).not.toContain("10.20.30.40");
    expect(out).not.toContain("172.16.8.9");
    expect(out).toContain("8.8.8.8");
    expect(out).toContain("[专有词已脱敏]");
    expect(out).not.toContain("极光智行-E08");
    expect(out).not.toContain("13800138000");
    expect(out).toContain("[手机号已脱敏]");
  });

  it("redactMessages 和 OpenAICompatibleGateway 正确透传自定义词表", async () => {
    const msgs = redactMessages([{ role: "user", content: "客户 华星电池厂 主机 172.31.0.5" }], ["华星电池厂"]);
    expect(msgs[0]?.content).toBe("客户 [专有词已脱敏] 主机 [内网IP已脱敏]");

    let sentBody = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const gw = new OpenAICompatibleGateway({
      classification: "internal",
      redact: true,
      redactTerms: ["天枢智驾平台"],
      providers: [{ id: "p1", name: "litellm", base_url: "http://127.0.0.1:4000", secret_id: "sec-1", models: ["deepseek-chat"], allowed_for_sensitive: false, enabled: true, priority: 100 }],
      routes: [{ id: "r1", task_tier: "fast", provider_id: "p1", model: "deepseek-chat", fallback_order: 1 }],
      apiKey: async () => "test-key",
      record: async () => {},
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await gw.complete("fast", [{ role: "user", content: "测试 天枢智驾平台 192.168.10.20 LSVAA4182E2184951" }]);
    expect(sentBody).not.toContain("天枢智驾平台");
    expect(sentBody).not.toContain("192.168.10.20");
    expect(sentBody).not.toContain("LSVAA4182E2184951");
    expect(sentBody).toContain("[专有词已脱敏]");
    expect(sentBody).toContain("[内网IP已脱敏]");
    expect(sentBody).toContain("[VIN已脱敏]");
  });
});

describe("P1 清理 B13 领域硬编码与 B19 假通过占位", () => {
  it("B13 生成通用工程入口，不再混入试制问题闭环台的专用规则", async () => {
    const out = await BLOCKS["B13"]!.chunk(fakeBlockContext(), 0);
    const server = String(out.payload["server"] ?? "");
    expect(server).toContain("expense_claim");
    expect(server).toContain("REQ-0001");
    expect(server).toContain("export function start()");
    expect(server).not.toContain("nodeColor");
    expect(server).not.toContain("canClose");
    expect(server).not.toContain("allowExport");
    expect(server).not.toContain("assignLate");
  });

  it("B19 生成的 pytest 与 Playwright 模板默认 skip，不再包含 assert True 假通过", async () => {
    const out = await BLOCKS["B19"]!.chunk(fakeBlockContext(), 0);
    const pytest = String(out.payload["pytest"] ?? "");
    const playwright = String(out.payload["playwright"] ?? "");
    expect(pytest).toContain("import pytest");
    expect(pytest).toContain("pytest.skip(");
    expect(pytest).not.toContain("assert True");
    expect(playwright).toContain("test.skip(!process.env.BASE_URL");
  });

  it("waiting_human 自动通知文案包含应用名、步骤名、运行编号和中文角色", () => {
    const notice = formatWaitingHumanNotice({
      appName: "极光智行整车OTA",
      runCode: "R-0012",
      stepName: "架构说明",
      role: "architect",
      prompt: "确认架构说明和架构图",
    });
    expect(notice.title).toBe("【待确认】极光智行整车OTA · 架构说明（R-0012）");
    expect(notice.body).toContain("架构师");
    expect(notice.body).toContain("确认架构说明和架构图");
  });
});
