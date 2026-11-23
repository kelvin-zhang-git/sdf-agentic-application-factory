import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { validateWorkflow } from "@/core/engine/validate";
import type { WorkflowDef } from "@/core/engine/builtin";

function def(steps: WorkflowDef["steps"]): WorkflowDef {
  return { key: "custom_flow", name: "自定义", steps };
}

describe("custom workflow checks", () => {
  it("rejects a missing artifact, a bad when, and an unknown goto", () => {
    const workflow = def([
      { key: "gate", name: "检查", stage: "质量", block: "B21", weights: ["standard"], checkpoints: {}, when: "status == ok", goto: "missing" },
      { key: "report", name: "报告", stage: "质量", block: "B20", weights: ["standard"], checkpoints: {} },
    ]);
    const issues = validateWorkflow(stringify(workflow), workflow, undefined, true);
    expect(issues.some((issue) => issue.includes("test_report"))).toBe(true);
    expect(issues.some((issue) => issue.includes("when"))).toBe(true);
    expect(issues.some((issue) => issue.includes("goto"))).toBe(true);
  });

  it("accepts a short chain that produces what the next step needs", () => {
    const workflow = def([
      { key: "import", name: "导入", stage: "需求", block: "B01", weights: ["standard"], checkpoints: {} },
      { key: "organize", name: "整理", stage: "需求", block: "B02", weights: ["standard"], checkpoints: {}, when: "weight == 'standard'" },
    ]);
    expect(validateWorkflow(stringify(workflow), workflow, undefined, true)).toEqual([]);
  });
});
