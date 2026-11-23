import { describe, expect, it } from "vitest";
import { dedupeFindings, dedupeTests, selectEffectiveReportIds } from "@/core/reports/aggregate";
import { normalizeAllowedPaths } from "@/core/design/task-paths";
import { outOfScope } from "@/core/connectors/paths";
import { BATCH3 } from "@/core/blocks/batch3";
import type { BlockContext } from "@/core/blocks";
import { AppError } from "@/core/errors";

function mockCtx(reply: () => Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }>): BlockContext {
  return {
    data: {
      app: { id: "app-1", name: "试制问题闭环台", classification: "internal", redact_before_llm: true },
      run: { id: "run-1", code: "R-0001", weight: "standard", inputs: {}, trace_id: "t-1", started_by: "u-1", snapshot: { steps: [] } },
      step: { id: "step-1", run_id: "run-1", app_id: "app-1", step_key: "tasks", block_key: "B14", attempt: 1, cursor_seq: 0, cursor: {}, checkpoint: null },
    },
    store: {
      requirements: async () => [
        { id: "r1", code: "REQ-0001", title: "工长开单", story: "工长手机登记问题", priority: "must", status: "approved", criteria: [{ code: "AC-0001", text: "现象至少 8 个字", format: "ears" }] },
      ],
      latestArtifact: async () => null,
      testCases: async () => [],
    } as unknown as BlockContext["store"],
    llm: {
      complete: async () => reply(),
    } as unknown as BlockContext["llm"],
    options: {},
    feedback: null,
  };
}

describe("P0 fixes", () => {
  it("aggregates active MR reports, excludes closed MRs, and prefers a newer whole-repo CI report", () => {
    const reports = [
      { id: "r-ci-old", merge_request_id: null, created_at: "2026-11-20T01:00:00Z" },
      { id: "r-mr1-v1", merge_request_id: "mr-1", created_at: "2026-11-20T02:00:00Z" },
      { id: "r-mr1-v2", merge_request_id: "mr-1", created_at: "2026-11-20T03:00:00Z" },
      { id: "r-mr2", merge_request_id: "mr-2", created_at: "2026-11-20T03:30:00Z" },
      { id: "r-closed", merge_request_id: "mr-closed", created_at: "2026-11-20T04:00:00Z" },
    ];
    const active = new Set(["mr-1", "mr-2"]);
    // 活跃 MR 各取最新（r-mr2 更新于 r-mr1-v2），已关闭 MR 自动排除
    expect(selectEffectiveReportIds(reports, active)).toEqual(["r-mr2", "r-mr1-v2"]);

    // 整库 CI 报告比所有活跃 MR 更新时，只取最新整库报告
    const withNewerCi = [...reports, { id: "r-ci-new", merge_request_id: null, created_at: "2026-11-20T05:00:00Z" }];
    expect(selectEffectiveReportIds(withNewerCi, active)).toEqual(["r-ci-new"]);

    // 没有活跃 MR 报告时退回历史全量报告（兼容存量数据）
    expect(selectEffectiveReportIds([reports[0]!], new Set())).toEqual(["r-ci-old"]);
  });

  it("deduplicates merged tests by newest report and deduplicates scan findings", () => {
    const tests = dedupeTests([
      { report_id: "old", name: "AC-0001 开单", ac_code: "AC-0001", status: "failed" },
      { report_id: "new", name: "AC-0001 开单", ac_code: "AC-0001", status: "passed" },
      { report_id: "old", name: "AC-0002 复测", ac_code: "AC-0002", status: "passed" },
    ], ["new", "old"]);
    expect(tests).toEqual([
      { report_id: "new", name: "AC-0001 开单", ac_code: "AC-0001", status: "passed" },
      { report_id: "old", name: "AC-0002 复测", ac_code: "AC-0002", status: "passed" },
    ]);

    const findings = dedupeFindings([
      { report_id: "r1", rule_id: "sdf-secret", level: "error", message: "密钥", path: "src/a.js" },
      { report_id: "r2", rule_id: "sdf-secret", level: "error", message: "密钥", path: "src/a.js" },
      { report_id: "r2", rule_id: "sdf-secret", level: "error", message: "密钥", path: "src/b.js" },
    ]);
    expect(findings.map((f) => f.path)).toEqual(["src/a.js", "src/b.js"]);
  });

  it("normalizes tests/ prefixes to test/ and guarantees test/ coverage for B14 allowed_paths", () => {
    const normalized = normalizeAllowedPaths(["src/domain/assignment/", "tests/assignment/"]);
    expect(normalized).toEqual(["src/domain/assignment/", "test/assignment/"]);
    expect(outOfScope(["src/domain/assignment/a.js", "test/assignment/a.test.js"], normalized, [".env"])).toEqual([]);

    const padded = normalizeAllowedPaths(["src/api/"]);
    expect(padded).toEqual(["src/api/", "test/"]);
    expect(outOfScope(["test/acceptance.test.js"], padded, [".env"])).toEqual([]);
  });

  it("propagates model errors and real token counts in batch3 blocks instead of swallowing them", async () => {
    const failCtx = mockCtx(async () => {
      throw new AppError("LLM_TIMEOUT", "模型响应超时");
    });
    await expect(BATCH3["B11"]!.chunk(failCtx, 0)).rejects.toMatchObject({ code: "LLM_TIMEOUT" });

    const badJsonCtx = mockCtx(async () => ({
      content: "这不是 JSON",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
    await expect(BATCH3["B12"]!.chunk(badJsonCtx, 0)).rejects.toMatchObject({ code: "LLM_BAD_FORMAT" });

    const okB14Ctx = mockCtx(async () => ({
      content: JSON.stringify({
        tasks: [{
          title: "工长开单模块",
          description: "实现工长开单接口与测试",
          requirement_codes: ["REQ-0001"],
          allowed_paths: ["src/orders/", "tests/orders/"],
          forbidden_paths: [],
        }],
      }),
      usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
    }));
    const res = await BATCH3["B14"]!.chunk(okB14Ctx, 0);
    expect(res.tokens).toBe(180);
    expect(res.calls).toBe(1);
    const tasks = res.payload["tasks"] as { allowed_paths: string[] }[];
    expect(tasks[0]?.allowed_paths).toEqual(["src/orders/", "test/orders/"]);
  });
});
