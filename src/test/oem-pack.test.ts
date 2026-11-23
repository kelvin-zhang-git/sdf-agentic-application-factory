import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { accountExpired, evidenceFiles, mockMes, requirementsCsv, requirementsReqif, specKitFiles, zipTextFiles } from "@/core/oem-pack";
import { segmentText } from "@/core/sources";

describe("oem pack", () => {
  const requirements = [{ code: "REQ-0001", title: "四小时内指派", story: "问题要有责任人", status: "approved", external_ref: "3.2.1", confirmed_at: "2026-11-15T00:00:00Z" }];
  const criteria = [{ requirement_code: "REQ-0001", code: "AC-0001", text: "超过四小时未指派则标红" }];

  it("keeps the customer clause number in csv and reqif", () => {
    const csv = requirementsCsv(requirements, criteria, [{ requirement_code: "REQ-0001", ac_code: "AC-0001", name: "AC-0001 指派", status: "passed" }]);
    expect(csv).toContain("3.2.1");
    expect(csv).toContain("AC-0001");
    const reqif = requirementsReqif(requirements, criteria);
    expect(reqif).toContain("REQ-0001");
    expect(reqif).toContain("3.2.1");
    expect(reqif).toContain("验收标准");
  });

  it("writes a spec kit directory and an evidence pack", () => {
    const kit = specKitFiles({ appName: "试制问题闭环台", constitution: "使用中文错误说明", requirements, tasks: [{ code: "T-0001", title: "登记页", paths: ["src/pages/issue-create/"] }] });
    expect(kit[".specify/memory/constitution.md"]).toContain("中文");
    expect(kit["specs/app/spec.md"]).toContain("REQ-0001");
    expect(kit["specs/app/tasks.md"]).toContain("src/pages/issue-create/");
    const packed = evidenceFiles({
      appName: "试制问题闭环台", version: "PT2-1", requirements, criteria,
      tests: [], findings: [], gate: [{ item_key: "ac_coverage", status: "FAILED", evidence: "覆盖不足" }],
      usage: [{ title: "需求清单", model: "sdf-standard", reviewed_at: null, edit_ratio: 0 }],
      gaps: ["低于 85%"],
    });
    expect(packed["说明.md"]).toContain("低于 85%");
    expect(packed["验收结论.csv"]).toContain("FAILED");
    const names = Object.keys(unzipSync(zipTextFiles(kit)));
    expect(names).toContain("specs/app/spec.md");
    expect(strFromU8(unzipSync(zipTextFiles(kit))["specs/app/spec.md"]!)).toContain("甲方编号：3.2.1");
  });

  it("reads a clause number from the start of a source line", () => {
    const segments = segmentText("3.2.1 问题产生后四小时内完成指派\n店长：每天补货");
    expect(segments[0]).toEqual({ speaker: null, text: "问题产生后四小时内完成指派", clause: "3.2.1" });
    expect(segments[1]).toEqual({ speaker: "店长", text: "每天补货" });
  });

  it("treats a past date as expired and keeps the mes mock local", () => {
    expect(accountExpired("2020-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:00Z"))).toBe(true);
    expect(accountExpired(null)).toBe(false);
    expect(mockMes().vehicles[0]?.code).toBe("PV-001");
  });
});
