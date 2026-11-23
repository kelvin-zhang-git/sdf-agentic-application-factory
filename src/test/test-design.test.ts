import { describe, expect, it } from "vitest";
import { fillCaseGaps, renderTestDesign } from "@/core/design/test-design";
import { renderContextPack } from "@/core/design/context-pack";

describe("test design", () => {
  it("fills a normal path and an exception path, then renders a readable document", () => {
    const cases = fillCaseGaps([{ code: "REQ-0001", title: "工长开单", criteria: [{ code: "AC-0008", text: "现象至少 8 个字" }] }], []);
    expect(cases.map((item) => item.kind)).toEqual(["normal", "exception"]);
    const text = renderTestDesign("试制问题闭环台", cases);
    expect(text).toContain("## REQ-0001");
    expect(text).toContain("### AC-0008 正常");
    expect(text).toContain("现象至少 8 个字");
    expect(text).toContain("系统拒绝这次操作");
  });

  it("keeps the task trailer after the test cases", () => {
    const pack = renderContextPack({
      code: "T-0001", title: "开单", description: "工长登记问题", criteria: [{ code: "AC-0008", text: "现象至少 8 个字" }],
      ddl: "", openapi: "", allowed_paths: ["src/"], forbidden_paths: [".env"],
      cases: [{ ac_code: "AC-0008", kind: "normal", title: "正常开单", steps: ["填写现象"], expected: "保存成功" }],
    });
    expect(pack).toContain("## 测试用例");
    expect(pack.trimEnd().endsWith("SDF-Task: T-0001")).toBe(true);
  });
});
