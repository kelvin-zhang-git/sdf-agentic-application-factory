import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { diffBaselines, explainBaseline } from "@/core/evolution/baseline";
import { keywordTriage } from "@/core/evolution/triage";

describe("stage 3 evolution", () => {
  it("classifies a wording change and explains a baseline diff", () => {
    const triaged = keywordTriage("希望把补货建议改成按门店改数量", ["REQ-0007"]);
    expect(triaged.category).toBe("change");
    expect(triaged.requirement_code).toBe("REQ-0007");
    const diff = diffBaselines(
      [{ code: "REQ-0007", title: "按区域给建议", version: 1 }],
      [{ code: "REQ-0007", title: "按门店改数量", version: 2 }],
    );
    expect(diff.changed.map((item) => item.code)).toEqual(["REQ-0007"]);
    expect(explainBaseline(diff, ["CR-0001"])).toContain("REQ-0007");
    expect(explainBaseline(diff, ["CR-0001"])).toContain("CR-0001");
  });

  it("keeps technical words off the business portal", () => {
    const portal = readFileSync(resolve("src/routes/_authenticated/portal.tsx"), "utf8");
    const collab = readFileSync(resolve("src/components/sdf/Stage3Panels.tsx"), "utf8");
    for (const word of ["OpenAPI", "DDL", "MR", "SARIF"]) {
      expect(portal.includes(word), word).toBe(false);
      expect(collab.includes(word), word).toBe(false);
    }
  });
});
