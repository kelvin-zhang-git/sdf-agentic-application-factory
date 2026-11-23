import { describe, expect, it } from "vitest";
import { artifactDiff, artifactFilename } from "@/core/artifacts";
describe("artifact versions", () => {
  it("reports the removed and added version lines", () => { const result = artifactDiff("limit: 5\n", "limit: 10\n"); expect(result).toEqual([{ text: "limit: 5\n", kind: "removed" }, { text: "limit: 10\n", kind: "added" }]); });
  it("keeps downloads inside a safe filename", () => { expect(artifactFilename("../工程规范", "markdown", 2)).toBe("___工程规范-v2.md"); });
});