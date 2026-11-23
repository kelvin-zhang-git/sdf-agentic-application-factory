import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { BLOCKS } from "@/core/blocks";
import { BUILTIN_WORKFLOWS } from "@/core/engine/builtin";
import { validateWorkflow } from "@/core/engine/validate";
import { AppError } from "@/core/errors";
import type { BlockContext } from "@/core/blocks";
import type { Requirement } from "@/core/engine/types";

const reqs: Requirement[] = [
  { id: "1", code: "REQ-0001", title: "店长能改数量", story: "", priority: "must", type: "feature", criteria: [] },
];

function fake(llm: BlockContext["llm"]): BlockContext {
  return {
    data: {
      step: { id: "s", run_id: "r", app_id: "a", step_key: "x", block_key: "B13", attempt: 1, cursor_seq: 0, cursor: null, checkpoint: null },
      run: { id: "r", code: "R-0009", weight: "standard", inputs: {}, trace_id: "t", started_by: "u", snapshot: { steps: [] } },
      app: { id: "a", name: "澄远零售", classification: "internal", redact_before_llm: true },
    },
    store: {
      requirements: async () => reqs,
      latestArtifact: async () => ({ content: "", content_json: { entities: [{ name: "store" }] } }),
      tasks: async () => [{ code: "T-0001", title: "改数量", status: "todo", assignee_kind: "human" }],
    } as unknown as BlockContext["store"],
    llm,
    options: {},
    feedback: null,
  };
}

const quiet = { complete: async () => { throw new Error("模型不可用"); } } as unknown as BlockContext["llm"];

describe("stage 6 blocks", () => {
  it("starts the scaffold workflow", () => {
    const row = BUILTIN_WORKFLOWS.find((item) => item.def.key === "scaffold_pack" && item.version === "1.0.0");
    expect(row?.startable).toBe(true);
    expect(validateWorkflow(stringify(row!.def), row!.def, undefined, true)).toEqual([]);
  });

  it("builds a secret-free skeleton and a task board", async () => {
    const scaffold = await BLOCKS["B13"]!.chunk(fake(quiet), 0);
    expect(String(scaffold.payload["pkg"])).toContain("\"name\": \"app\"");
    expect(String(scaffold.payload["pkg"])).toContain("\"test\": \"node --test\"");
    expect(String(scaffold.payload["tests"])).toContain("node:test");
    expect(String(scaffold.payload["readme"])).toContain("REQ-0001");
    expect(String(scaffold.payload["server"])).toContain("store");
    const board = await BLOCKS["B29"]!.chunk(fake(quiet), 0);
    expect(String(board.payload["markdown"])).toContain("T-0001");
    expect(String(board.payload["markdown"])).toContain("人");
    const pack = await BLOCKS["B28"]!.chunk(fake(quiet), 0);
    expect(String(pack.payload["content"])).toContain("sdfpack");
    expect(String(pack.payload["content"])).not.toMatch(/sk-|@/);
  });

  it("stops when a sensitive application is refused", async () => {
    const llm = { complete: async () => { throw new AppError("LLM_SENSITIVE_FORBIDDEN", "敏感应用不能调用这个模型"); } } as unknown as BlockContext["llm"];
    await expect(BLOCKS["B13"]!.chunk(fake(llm), 0)).rejects.toMatchObject({ code: "LLM_SENSITIVE_FORBIDDEN" });
  });

  it("writes the scaffold workflow once", async () => {
    if (!process.env["SDF_PG_SERVICE_PASSWORD"]) return;
    const { ensureBuiltinWorkflows } = await import("@/adapters/ensure-builtins");
    const { serviceQuery } = await import("@/adapters/pg-client");
    await ensureBuiltinWorkflows();
    const rows = await serviceQuery()(
      "SELECT key, version, startable FROM public.workflows WHERE key = 'scaffold_pack' AND version = '1.0.0'",
      [],
    );
    expect(rows).toEqual([{ key: "scaffold_pack", version: "1.0.0", startable: true }]);
  });
});
