import { describe, expect, it, vi } from "vitest";
import {
  callChatCompletion,
  redactPii,
  redactMessages,
  selectModelCandidates,
  type LlmProvider,
  type ModelRoute,
} from "@/core/llm";

const provider = (id: string, allowed = false, enabled = true): LlmProvider => ({
  id, name: id, base_url: "https://models.example/v1", models: ["model-a"], secret_id: `secret-${id}`,
  allowed_for_sensitive: allowed, enabled, priority: 100,
});
const route = (id: string, provider_id: string, order: number): ModelRoute => ({
  id, task_tier: "standard", provider_id, model: "model-a", fallback_order: order,
});

describe("model routing", () => {
  it("orders primary and fallback models by the configured fallback_order", () => {
    const result = selectModelCandidates("standard", "internal", [provider("a"), provider("b")], [route("r2", "b", 2), route("r1", "a", 1)]);
    expect(result.map((x) => x.provider.id)).toEqual(["a", "b"]);
  });

  it("allows only explicitly authorized providers for sensitive and confidential apps", () => {
    const result = selectModelCandidates("standard", "sensitive", [provider("a"), provider("b", true)], [route("r1", "a", 1), route("r2", "b", 2)]);
    expect(result.map((x) => x.provider.id)).toEqual(["b"]);
    expect(() => selectModelCandidates("standard", "confidential", [provider("a")], [route("r1", "a", 1)])).toThrowError(expect.objectContaining({ code: "LLM_SENSITIVE_FORBIDDEN" }));
  });

  it("does not silently fall back to an unauthorized model", () => {
    expect(() => selectModelCandidates("deep", "sensitive", [provider("a")], [{ ...route("r1", "a", 1), task_tier: "deep" }])).toThrow("敏感或机密应用没有可用的已授权模型");
  });
});

describe("pre-model PII redaction", () => {
  it("replaces phone, PRC id, email and bank card values", () => {
    const input = "手机 13812345678，身份证 11010519491231002X，邮箱 a.person@example.com，银行卡 6222021234567890123";
    const output = redactPii(input);
    expect(output).not.toContain("13812345678");
    expect(output).not.toContain("11010519491231002X");
    expect(output).not.toContain("a.person@example.com");
    expect(output).not.toContain("6222021234567890123");
    expect(output).toContain("[手机号已脱敏]");
    expect(output).toContain("[身份证号已脱敏]");
    expect(output).toContain("[邮箱已脱敏]");
    expect(output).toContain("[银行卡号已脱敏]");
  });

  it("redacts every message without changing its role", () => {
    expect(redactMessages([{ role: "user", content: "联系 13812345678" }])).toEqual([{ role: "user", content: "联系 [手机号已脱敏]" }]);
  });
});

describe("OpenAI-compatible HTTP contract", () => {
  it("uses the database-provided model id and records returned usage", async () => {
    let seenBody = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenBody = String(init?.body);
      return Response.json({
        choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    };
    const result = await callChatCompletion({ baseUrl: "https://models.example/v1", apiKey: "secret", model: "db-model-id", messages: [{ role: "user", content: "test" }], fetchImpl });
    expect(JSON.parse(seenBody).model).toBe("db-model-id");
    expect(result).toEqual({ content: "OK", usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  });

  it("maps a bad address to a Chinese connection error", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(callChatCompletion({ baseUrl: "https://invalid.example/v1", apiKey: "secret", model: "model-a", messages: [{ role: "user", content: "test" }], fetchImpl: fetchImpl as typeof fetch })).rejects.toMatchObject({ code: "LLM_UNAVAILABLE", message: "无法连接模型服务，请检查地址和网络" });
  });
});
