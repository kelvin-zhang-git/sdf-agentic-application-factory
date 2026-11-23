import { describe, expect, it } from "vitest";
import { matchTask } from "@/core/connectors/match";
import { outOfScope } from "@/core/connectors/paths";
import { signHex, verifyHexSignature } from "@/core/connectors/sign";
import { parseJunit } from "@/core/reports/junit";
import { evaluateGate } from "@/core/reports/gate";

describe("stage 2 matching and gates", () => {
  it("claims by trailer, then title, then branch", () => {
    const codes = ["T-0001", "T-0002"];
    expect(matchTask({ title: "别的", body: "说明\nSDF-Task: T-0002\n", branch: "sdf/T-0001-x" }, codes)?.matched_by).toBe("body_trailer");
    expect(matchTask({ title: "[T-0001] 补货", body: "", branch: "feature" }, codes)?.code).toBe("T-0001");
    expect(matchTask({ title: "无编号", body: "", branch: "sdf/T-0002-fix" }, codes)?.matched_by).toBe("branch_name");
    expect(matchTask({ title: "[T-9999]", body: "", branch: "main" }, codes)).toBeNull();
  });

  it("flags files outside the allowed tree and secret files", () => {
    expect(outOfScope(["src/replenish/ok.ts", ".env", "docs/note.md"], ["src/**"], [".env", "**/.env"])).toEqual([".env", "docs/note.md"]);
  });

  it("rejects a tampered webhook body", () => {
    const raw = "{\"ok\":true}";
    const secret = "hook-secret";
    expect(verifyHexSignature(secret, raw, signHex(secret, raw))).toBe(true);
    expect(verifyHexSignature(secret, raw, signHex(secret, raw + " "))).toBe(false);
    expect(verifyHexSignature(secret, raw, undefined)).toBe(false);
  });

  it("parses junit without external entities and keeps a missing scan as not executed", () => {
    expect(() => parseJunit("<!DOCTYPE foo [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]>")).toThrow(/外部实体/);
    const tests = parseJunit(`<testsuite><testcase name="AC-0001-01 可见"/><testcase name="AC-0001-02 拒绝"><failure>boom</failure></testcase></testsuite>`);
    expect(tests.map((item) => item.status)).toEqual(["passed", "failed"]);
    const gate = evaluateGate({
      rules: { coverage_min: 0.8, pass_rate: 1, sarif_high_max: 0, out_of_scope_max: 0 },
      acTotal: 2, acCovered: 2, testsTotal: 2, testsFailed: 0, hasJunit: true, hasSarif: false, sarifHigh: 0, hasMergeRequest: true, outOfScopeFiles: 1,
    });
    expect(gate.items.find((item) => item.item_key === "ac_coverage")).toMatchObject({ status: "PASSED", numerator: 2, denominator: 2 });
    expect(gate.items.find((item) => item.item_key === "sarif_high")?.status).toBe("NOT_EXECUTED");
    expect(gate.items.find((item) => item.item_key === "out_of_scope")?.status).toBe("FAILED");
    expect(gate.met).toBe(false);
  });
});
