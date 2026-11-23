import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { BLOCKS } from "@/core/blocks";
import { BUILTIN_WORKFLOWS } from "@/core/engine/builtin";
import { validateWorkflow } from "@/core/engine/validate";
import { AppError } from "@/core/errors";
import type { BlockContext } from "@/core/blocks";
import type { Requirement } from "@/core/engine/types";

const reqs: Requirement[] = [
  { id: "2", code: "REQ-0002", title: "可以稍后做", story: "", priority: "could", type: "feature", criteria: [{ code: "AC-2", format: "rule", text: "列表能打开" }] },
  { id: "1", code: "REQ-0001", title: "必须先做", story: "", priority: "must", type: "feature", criteria: [{ code: "AC-1", format: "rule", text: "店长能改数量" }] },
];

function fake(llm: BlockContext["llm"], artifact: { content: string; content_json: unknown } | null = null): BlockContext {
  return {
    data: {
      step: { id: "s", run_id: "r", app_id: "a", step_key: "x", block_key: "B07", attempt: 1, cursor_seq: 0, cursor: null, checkpoint: null },
      run: { id: "r", code: "R-0008", weight: "standard", inputs: {}, trace_id: "t", started_by: "u", snapshot: { steps: [] } },
      app: { id: "a", name: "澄远零售", classification: "internal", redact_before_llm: true },
    },
    store: { requirements: async () => reqs, latestArtifact: async () => artifact } as unknown as BlockContext["store"],
    llm,
    options: {},
    feedback: null,
  };
}

const quiet = { complete: async () => { throw new Error("模型不可用"); }, json: async () => { throw new Error("模型不可用"); } } as unknown as BlockContext["llm"];

describe("stage 5 blocks", () => {
  it("starts the delivery pack and the hotfix 1.1.0", () => {
    for (const key of [["delivery_pack", "1.0.0"], ["hotfix_light", "1.1.0"]] as const) {
      const row = BUILTIN_WORKFLOWS.find((item) => item.def.key === key[0] && item.version === key[1]);
      expect(row?.startable).toBe(true);
      expect(validateWorkflow(stringify(row!.def), row!.def, undefined, true)).toEqual([]);
    }
    const old = BUILTIN_WORKFLOWS.find((item) => item.def.key === "hotfix_light" && item.version === "1.0.0");
    expect(old?.startable).toBe(false);
  });

  it("orders requirements and still finishes when the model is down", async () => {
    const chunk = await BLOCKS["B07"]!.chunk(fake(quiet), 0);
    const done = BLOCKS["B07"]!.finalize(fake(quiet), [chunk.payload]);
    const content = String((done.result["artifact"] as { content: string }).content);
    expect(content.indexOf("REQ-0001")).toBeLessThan(content.indexOf("REQ-0002"));
    expect(content).toContain("必须");
  });

  it("refuses to score a sensitive application when the gateway forbids it", async () => {
    const llm = { complete: async () => { throw new AppError("LLM_SENSITIVE_FORBIDDEN", "敏感应用不能调用这个模型"); } } as unknown as BlockContext["llm"];
    await expect(BLOCKS["B07"]!.chunk(fake(llm), 0)).rejects.toMatchObject({ code: "LLM_SENSITIVE_FORBIDDEN" });
  });

  it("draws the data model and drafts tests plus a secret-free deploy pack", async () => {
    const sketch = await BLOCKS["B06"]!.chunk(fake(quiet, { content: "", content_json: { entities: [{ name: "store" }] } }), 0);
    expect(String(sketch.payload["markdown"])).toContain("E1：store");
    expect(String(sketch.payload["markdown"])).toContain("erDiagram");
    const tests = await BLOCKS["B19"]!.chunk(fake(quiet), 0);
    const scripts = BLOCKS["B19"]!.finalize(fake(quiet), [tests.payload]);
    const files = scripts.result["artifacts"] as { content: string }[];
    expect(files[0]?.content).toContain("店长能改数量");
    expect(files[1]?.content).toContain("playwright");
    const pack = await BLOCKS["B23"]!.chunk(fake(quiet), 0);
    const env = String(pack.payload["envFile"]);
    expect(env).toContain("SDF_PG_PASSWORD=");
    expect(env).not.toMatch(/sk-|postgres:\/\/.+:.+@/);
  });

  it("writes the new builtin workflows once", async () => {
    if (!process.env["SDF_PG_SERVICE_PASSWORD"]) return;
    const { ensureBuiltinWorkflows } = await import("@/adapters/ensure-builtins");
    const { serviceQuery } = await import("@/adapters/pg-client");
    await ensureBuiltinWorkflows();
    const rows = await serviceQuery()(
      "SELECT key, version, startable FROM public.workflows WHERE (key = 'delivery_pack' AND version = '1.0.0') OR (key = 'hotfix_light' AND version = '1.1.0') ORDER BY key",
      [],
    );
    expect(rows.map((row) => `${row["key"]}:${row["version"]}:${row["startable"]}`)).toEqual(["delivery_pack:1.0.0:true", "hotfix_light:1.1.0:true"]);
  });
});
