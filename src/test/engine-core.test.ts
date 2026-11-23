import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@/core/errors";
import { classifyModelError, runStep } from "@/core/engine/runner";
import { planPreview, validateWorkflow } from "@/core/engine/validate";
import { REQUIREMENT_ONLY } from "@/core/engine/builtin";
import { checkSourceFile, segmentText } from "@/core/sources";
import { ruleFindings } from "@/core/blocks";
import { constitutionSchema } from "@/core/blocks/b08";
import { extractJson, OpenAICompatibleGateway } from "@/core/model-gateway";
import { z } from "zod";
import { stringify } from "yaml";
import type { EngineStore } from "@/core/engine/types";

describe("workflow definition", () => {
  it("requirement_only light/standard/full checkpoints differ as specified", () => {
    expect(planPreview(REQUIREMENT_ONLY, "light").map((s) => s.checkpoint)).toEqual([null, null, "ba", null, null]);
    expect(planPreview(REQUIREMENT_ONLY, "standard").map((s) => s.checkpoint)).toEqual([null, null, "ba", null, null]);
    expect(planPreview(REQUIREMENT_ONLY, "full").map((s) => s.checkpoint)).toEqual([null, "ba", "ba", "lead", null]);
    expect(REQUIREMENT_ONLY.steps.map((s) => s.block)).toEqual(["B01", "B02", "B03", "B04", "B26"]);
    const paused = planPreview(REQUIREMENT_ONLY, "standard", ["B03"]);
    expect(paused.find((step) => step.block === "B03")?.skipped).toBe(true);
    expect(paused.find((step) => step.block === "B01")?.skipped).toBe(false);
  });
  it("validation flags unimplemented blocks and YAML drift", () => {
    expect(validateWorkflow(stringify(REQUIREMENT_ONLY), REQUIREMENT_ONLY)).toEqual([]);
    const bad = { ...REQUIREMENT_ONLY, steps: [...REQUIREMENT_ONLY.steps, { key: "later", name: "后续", stage: "x", block: "B99", weights: ["standard" as const], checkpoints: {} }] };
    expect(validateWorkflow(stringify(bad), bad)).toContain("包含未实施积木 B99");
    expect(validateWorkflow("key: other", REQUIREMENT_ONLY)).toContain("YAML 与已保存的定义不一致");
  });
});

describe("source checks", () => {
  it("rejects empty, oversized, wrong type and mismatched mime", () => {
    expect(() => checkSourceFile("a.txt", "text/plain", 0)).toThrow("文件是空的");
    expect(() => checkSourceFile("a.txt", "text/plain", 10 * 1024 * 1024 + 1)).toThrow("10 MB");
    expect(() => checkSourceFile("a.exe", "application/octet-stream", 5)).toThrow("只支持");
    expect(() => checkSourceFile("a.pdf", "text/plain", 5)).toThrow("不一致");
    expect(checkSourceFile("a.md", "text/markdown", 5)).toBe("md");
  });
  it("splits speakers and lines; empty text fails", () => {
    expect(segmentText("店长：每天补货\n\n区域经理: 可调整\n备注")).toEqual([{ speaker: "店长", text: "每天补货" }, { speaker: "区域经理", text: "可调整" }, { speaker: null, text: "备注" }]);
    expect(() => segmentText("  \n ")).toThrow("没有解析出");
  });
});

describe("blocks", () => {
  it("rule check finds missing criteria and vague words", () => {
    const f = ruleFindings([{ id: "r1", code: "REQ-0001", title: "t", story: "尽快响应", priority: "must", type: "functional", criteria: [] }]);
    expect(f.map((x) => [x.severity, x.category])).toEqual([["major", "missing_ac"], ["minor", "vague"]]);
  });
  it("B08 form requires every mandatory field", () => {
    expect(constitutionSchema.safeParse({ stack: "a", naming: "b", security: "", performance: "d" }).success).toBe(false);
  });
});

describe("model errors map to waiting reasons", () => {
  it("not configured never auto-retries; 429 is rate limited; 5xx/timeout are temporary; sensitive fails", () => {
    expect(classifyModelError(new AppError("LLM_NOT_CONFIGURED", "x")).wait).toBe("model_not_configured");
    expect(classifyModelError(new AppError("LLM_HTTP", "x", { http_status: 429 })).wait).toBe("rate_limited");
    expect(classifyModelError(new AppError("LLM_HTTP", "x", { http_status: 503 })).wait).toBe("model_unavailable");
    expect(classifyModelError(new AppError("LLM_TIMEOUT", "x")).wait).toBe("model_unavailable");
    expect(classifyModelError(new AppError("LLM_SENSITIVE_FORBIDDEN", "x")).wait).toBeUndefined();
    expect(classifyModelError(new AppError("LLM_BAD_FORMAT", "x")).wait).toBeUndefined();
  });
});

describe("gateway", () => {
  const provider = { id: "p", name: "n", base_url: "https://gw.example/v1", models: ["m"], secret_id: "s", allowed_for_sensitive: false, enabled: true, priority: 1 };
  const route = { id: "r", task_tier: "standard" as const, provider_id: "p", model: "m", fallback_order: 1 };
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 3 } }));
  it("retries a bad format once with the error, then fails LLM_BAD_FORMAT", async () => {
    let n = 0;
    const gw = new OpenAICompatibleGateway({ classification: "internal", redact: false, providers: [provider], routes: [route], apiKey: async () => "k", record: async () => undefined, fetchImpl: (async () => { n++; return reply("not json"); }) as typeof fetch });
    await expect(gw.json("standard", z.object({ a: z.number() }), [{ role: "user", content: "x" }])).rejects.toMatchObject({ code: "LLM_BAD_FORMAT" });
    expect(n).toBe(2);
  });
  it("confidential app without authorized service sends no request", async () => {
    let n = 0;
    const gw = new OpenAICompatibleGateway({ classification: "confidential", redact: true, providers: [provider], routes: [route], apiKey: async () => "k", record: async () => undefined, fetchImpl: (async () => { n++; return reply("{}"); }) as typeof fetch });
    await expect(gw.complete("standard", [{ role: "user", content: "x" }])).rejects.toMatchObject({ code: "LLM_SENSITIVE_FORBIDDEN" });
    expect(n).toBe(0);
  });
  it("extracts fenced JSON", () => { expect(extractJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 }); });
});

describe("runner", () => {
  it("not-configured model puts the step in waiting_model without content", async () => {
    const calls: string[] = [];
    const store = {
      context: async () => ({ step: { id: "s", run_id: "r", app_id: "a", step_key: "organize", block_key: "B02", attempt: 1, cursor_seq: 0, cursor: null, checkpoint: null },
        run: { id: "r", code: "R-1", weight: "standard", inputs: {}, trace_id: "t", started_by: "u", snapshot: { steps: [] } }, app: { id: "a", name: "A", classification: "internal", redact_before_llm: false } }),
      gateway: async () => ({ complete: async () => { throw new AppError("LLM_NOT_CONFIGURED", "x"); }, json: async () => { throw new AppError("LLM_NOT_CONFIGURED", "x"); } }),
      segments: async () => [{ id: "g", source_id: "x", source_code: "SRC-1", seq: 1, speaker: null, text: "t" }],
      requirements: async () => [], heartbeat: async () => undefined,
      saveChunk: async () => { calls.push("save"); return true; }, merge: async () => { calls.push("merge"); return "succeeded"; },
      waitModel: async (_s: string, _l: string, reason: string) => { calls.push(`wait:${reason}`); }, fail: async () => { calls.push("fail"); },
    } as unknown as EngineStore;
    await runStep(store, "s", "lease", Date.now() + 10_000);
    expect(calls).toEqual(["wait:model_not_configured"]);
  });
});

describe("guard: no vendor coupling in app code", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (!["test", "integrations"].includes(f)) walk(p); } else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
  walk(join(process.cwd(), "src"));
  it("src has no DeepSeek URL, model names or vendor SDK imports", () => {
    const hits = files.filter((f) => /deepseek|api\.openai\.com|from ["'](openai|@anthropic-ai|@google\/generative-ai)/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
    const pkg = readFileSync(join(process.cwd(), "package.json"), "utf8");
    expect(/"(openai|deepseek[^"]*|@anthropic-ai\/sdk|@supabase\/supabase-js|@lovable\.dev\/[^"]*)"/.test(pkg)).toBe(false);
    const banned = files.filter((f) => /@supabase|@lovable\.dev|supabase\.co/.test(readFileSync(f, "utf8")));
    expect(banned).toEqual([]);
  });
});
