import { describe, expect, it } from "vitest";
import { allowExport, assignLate, canClose, nodeColor, ruleKind, ruleTestSource, serverModuleSource } from "@/core/trial-rules";

describe("trial rules", () => {
  it("checks assignment, close, node color and export permission", () => {
    expect(assignLate(5, false)).toBe(false);
    expect(assignLate(4, false)).toBe(true);
    expect(canClose(false)).toBe(false);
    expect(nodeColor(6)).toBe("red");
    expect(nodeColor(5)).toBe("green");
    expect(allowExport("business")).toBe(false);
    expect(allowExport("qa")).toBe(true);
  });

  it("names each test with the acceptance code", () => {
    expect(ruleKind("四小时内完成指派")).toBe("assign");
    const source = ruleTestSource([{ code: "AC-8001", title: "四小时内完成指派", kind: "assign" }]);
    expect(source).toContain("AC-8001");
    expect(serverModuleSource("// entity store").trimEnd().endsWith("export function start() { return { ok: true }; }")).toBe(true);
  });
});
