import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKFLOWS } from "@/core/engine/builtin";
import { validateWorkflow } from "@/core/engine/validate";
import { BLOCKS } from "@/core/blocks";
import { AppError } from "@/core/errors";
import type { EngineStore } from "@/core/engine/types";

describe("阶段 8 工作流", () => {
  it("文档补全和代码评审都能启动", () => {
    for (const key of ["doc_backfill", "code_review_flow"]) {
      const found = BUILTIN_WORKFLOWS.find((item) => item.def.key === key && item.version === "1.0.0");
      expect(found?.startable).toBe(true);
      expect(validateWorkflow(stringify(found!.def), found!.def, undefined, true)).toEqual([]);
    }
  });
});

describe("B17 代码评审", () => {
  it("没有合并请求时仍给出对照材料，不写评论", async () => {
    const comment = vi.fn();
    const store = { reviewTargets: vi.fn(async () => ({ constitution: "接口要有错误码", criteria: "登录失败有提示", pulls: [] })), commentOnPull: comment } as unknown as EngineStore;
    const block = BLOCKS["B17"]!;
    const out = await block.chunk({ store, data: { app: { id: "app" } }, llm: { complete: vi.fn() } } as never, 0);
    expect(String(out.payload["markdown"])).toContain("没有打开的合并请求");
    expect(comment).not.toHaveBeenCalled();
  });

  it("敏感内容错误继续抛出", async () => {
    const store = { reviewTargets: vi.fn(async () => ({ constitution: "", criteria: "", pulls: [{ number: 1, title: "改登录", diff: "password" }] })), commentOnPull: vi.fn() } as unknown as EngineStore;
    const llm = { complete: vi.fn(async () => { throw new AppError("LLM_SENSITIVE_FORBIDDEN", "敏感"); }) };
    await expect(BLOCKS["B17"]!.chunk({ store, data: { app: { id: "app" } }, llm } as never, 0)).rejects.toMatchObject({ code: "LLM_SENSITIVE_FORBIDDEN" });
  });
});

describe("B30 交付流度量", () => {
  it("模型失败时仍然保留样本量", async () => {
    const store = { flowMetrics: vi.fn(async () => ({ cycle_hours: 2.5, cycle_samples: 4, stages: [], requirements: 3, covered_requirements: 1, approved: 2, decided: 3 })) } as unknown as EngineStore;
    const llm = { complete: vi.fn(async () => { throw new AppError("LLM_UNAVAILABLE", "超时"); }) };
    const out = await BLOCKS["B30"]!.chunk({ store, data: { app: { id: "app" } }, llm } as never, 0);
    expect(String(out.payload["markdown"])).toContain("样本量 4");
  });
});

describe("命令行和 MCP", () => {
  it("没有参数时返回非零", () => {
    const result = spawnSync(process.execPath, ["bin/sdf.mjs"], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });

  it("MCP 提供六个工具", () => {
    const source = readFileSync(join(process.cwd(), "mcp/sdf-mcp-server.mjs"), "utf8");
    const names = [...source.matchAll(/name: "([^"]+)"/g)].map((item) => item[1] ?? "").filter((name) => name !== "sdf");
    expect(names).toEqual(["list_apps", "spec_get", "task_context", "constitution_get", "task_set_status", "gate_check"]);
  });
});
