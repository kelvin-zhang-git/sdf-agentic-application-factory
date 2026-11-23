export type GateStatus = "PASSED" | "FAILED" | "NOT_EXECUTED";
export interface GateItem { item_key: string; status: GateStatus; numerator: number | null; denominator: number | null; evidence: string }
export interface GateRules { coverage_min: number; pass_rate: number; sarif_high_max: number; out_of_scope_max: number }

export interface GateInput {
  rules: GateRules;
  acTotal: number;
  acCovered: number;
  testsTotal: number;
  testsFailed: number;
  hasJunit: boolean;
  hasSarif: boolean;
  sarifHigh: number;
  hasMergeRequest: boolean;
  outOfScopeFiles: number;
}

function ratio(ok: boolean, numerator: number | null, denominator: number | null, evidence: string, item_key: string): GateItem {
  return { item_key, status: ok ? "PASSED" : "FAILED", numerator, denominator, evidence };
}

/** 没有证据就标未执行，不能把缺报告当成通过。 */
export function evaluateGate(input: GateInput): { met: boolean; items: GateItem[] } {
  const coverage = !input.hasJunit || input.acTotal === 0
    ? { item_key: "ac_coverage", status: "NOT_EXECUTED" as const, numerator: input.hasJunit ? input.acCovered : null, denominator: input.hasJunit ? input.acTotal : null, evidence: input.hasJunit ? "没有验收标准" : "没有测试报告" }
    : ratio(input.acCovered / input.acTotal >= input.rules.coverage_min, input.acCovered, input.acTotal, `${input.acCovered}/${input.acTotal}`, "ac_coverage");
  const passing = !input.hasJunit || input.testsTotal === 0
    ? { item_key: "test_pass_rate", status: "NOT_EXECUTED" as const, numerator: input.hasJunit ? input.testsTotal - input.testsFailed : null, denominator: input.hasJunit ? input.testsTotal : null, evidence: "没有可统计的测试用例" }
    : ratio((input.testsTotal - input.testsFailed) / input.testsTotal >= input.rules.pass_rate, input.testsTotal - input.testsFailed, input.testsTotal, `${input.testsTotal - input.testsFailed}/${input.testsTotal}`, "test_pass_rate");
  const scan = !input.hasSarif
    ? { item_key: "sarif_high", status: "NOT_EXECUTED" as const, numerator: null, denominator: null, evidence: "没有上传安全扫描报告" }
    : ratio(input.sarifHigh <= input.rules.sarif_high_max, input.sarifHigh, null, String(input.sarifHigh), "sarif_high");
  const scope = !input.hasMergeRequest
    ? { item_key: "out_of_scope", status: "NOT_EXECUTED" as const, numerator: null, denominator: null, evidence: "还没有认领合并请求" }
    : ratio(input.outOfScopeFiles <= input.rules.out_of_scope_max, input.outOfScopeFiles, null, String(input.outOfScopeFiles), "out_of_scope");
  const items = [coverage, passing, scan, scope];
  const met = items.every((item) => item.status === "PASSED");
  return { met, items };
}
