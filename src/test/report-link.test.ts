import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { buildDocx, markdownToSections, STANDARD_TEMPLATE_NAME } from "@/core/docx-export";
import { analysisReportMarkdown, stampRequirementMarkdown, withRequirementLink } from "@/core/report-link";

const reqs = [{ id: "r1", code: "REQ-0001", title: "开单页免前置选择直接进入", priority: "must" }];

describe("requirement report correspondence", () => {
  it("binds a finding to the stored requirement and drops an invented code", () => {
    const md = analysisReportMarkdown([
      { severity: "minor", description: "REQ-9999 含有含糊用语：快速", suggestion: "改为可度量的描述", target_refs: [{ type: "requirement", id: "r1" }] },
    ], reqs);
    expect(md).toContain("REQ-0001《开单页免前置选择直接进入》");
    expect(md).toContain("## 与需求清单的对应");
    expect(md).not.toContain("REQ-9999");
  });

  it("annotates an existing analysis report and stays stable", () => {
    const old = "# 需求分析报告\n\n- **建议** REQ-0001 含有含糊用语：快速\n- **建议** REQ-0046 含有含糊用语：及时\n";
    const linked = withRequirementLink("analysis", old, reqs);
    expect(linked).toContain("REQ-0001《开单页免前置选择直接进入》");
    expect(linked).toContain("REQ-0046（需求清单中没有这个编号）");
    expect(linked).toContain("| REQ-0001 | 开单页免前置选择直接进入 | 对应需求清单 |");
    expect(withRequirementLink("analysis", linked, reqs)).toBe(linked);
  });

  it("writes formal codes onto the numbered requirement list once", () => {
    const src = "# 需求清单\n\n## 1. 开单页免前置选择直接进入\n\n作为总装工长";
    const stamped = stampRequirementMarkdown(src, reqs);
    expect(stamped).toContain("## REQ-0001 开单页免前置选择直接进入");
    expect(stamped).toContain("| REQ-0001 | 开单页免前置选择直接进入 | must |");
    expect(stampRequirementMarkdown(stamped, reqs)).toBe(stamped);
  });
});

describe("standard document template", () => {
  it("splits markdown tables and stamps the standard cover", () => {
    const sections = markdownToSections("# 需求分析报告\n\n## 与需求清单的对应\n\n| 报告编号 | 需求清单标题 |\n| --- | --- |\n| REQ-0001 | 开单页 |\n");
    expect(sections.find((s) => s.heading === "与需求清单的对应")?.table?.[0]).toEqual(["报告编号", "需求清单标题"]);
    expect(sections.find((s) => s.heading === "与需求清单的对应")?.table?.[1]).toEqual(["REQ-0001", "开单页"]);
    const bytes = buildDocx("需求分析报告", sections, { templateName: STANDARD_TEMPLATE_NAME, appName: "试制问题闭环台", classification: "内部", version: "v1", generatedAt: "2026-11-15" });
    const xml = new TextDecoder().decode(unzipSync(bytes)["word/document.xml"]);
    const header = new TextDecoder().decode(unzipSync(bytes)["word/header1.xml"]);
    const footer = new TextDecoder().decode(unzipSync(bytes)["word/footer1.xml"]);
    expect(xml).toContain("标准交付文档");
    expect(xml).toContain("试制问题闭环台");
    expect(xml).toContain("内部");
    expect(header.length).toBeGreaterThan(20);
    expect(footer).toContain("PAGE");
    expect(footer).toContain("NUMPAGES");
  });
});
