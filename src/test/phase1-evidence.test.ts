import { describe, expect, it } from "vitest";
import { acceptanceTestSource, editRatio, runNodeTests, safeJoin, secretSarif } from "@/core/acceptance-run";
import { parseJunit } from "@/core/reports/junit";
import { parseSarif } from "@/core/reports/sarif";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("phase 1 evidence", () => {
  it("measures how much a review changed the text", () => {
    expect(editRatio("abc", "abc")).toBe(0);
    expect(editRatio("abcd", "ab")).toBeGreaterThan(0);
    expect(editRatio("", "")).toBe(0);
  });

  it("writes a SARIF result when a generated file contains a secret", () => {
    const clean = parseSarif(secretSarif([{ path: "src/server.js", content: "export function start(){return {ok:true}}" }]));
    const dirty = parseSarif(secretSarif([{ path: ".env", content: "password=secret-value" }]));
    expect(clean).toEqual([]);
    expect(dirty[0]?.level).toBe("error");
    expect(dirty[0]?.path).toBe(".env");
  });

  it("refuses a path that leaves the work directory", () => {
    expect(() => safeJoin(join(tmpdir(), "sdf-acc"), "../outside.js")).toThrow(/工程目录/);
  });

  it("runs the generated acceptance test and keeps the requirement code", async () => {
    const xml = await runNodeTests([
      { path: "package.json", content: '{"type":"module"}\n' },
      { path: "src/server.js", content: "export function start(){return {ok:true}}\n" },
      { path: "test/acceptance.test.js", content: acceptanceTestSource([{ name: "AC-0001 可以启动" }]) },
    ]);
    expect(parseJunit(xml).some((item) => item.ac_code === "AC-0001" && item.status === "passed")).toBe(true);
  });
});
