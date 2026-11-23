import { describe, expect, it } from "vitest";
import { normalizeModel, renderDdl } from "@/core/design/ddl";
import { renderOpenApi } from "@/core/design/openapi";
import { checkMermaid, renderContextPack } from "@/core/design/context-pack";
import { renderPipeline } from "@/core/design/pipeline";
import { buildDocx } from "@/core/docx-export";
import { NEW_APP_SMALL } from "@/core/engine/builtin";
import { planPreview } from "@/core/engine/validate";

describe("stage 1 generators", () => {
  it("renders executable DDL and rejects names or types outside the allow list", () => {
    const sql = renderDdl([{
      name: "replenishment", comment: "补货建议",
      fields: [{ name: "id", type: "uuid", primary_key: true, default: "gen_random_uuid()" }, { name: "store_id", type: "text", nullable: false }],
      indexes: [{ name: "replenishment_store", columns: ["store_id"] }],
    }]);
    expect(sql).toContain('CREATE TABLE "replenishment"');
    expect(sql).toContain('PRIMARY KEY');
    expect(() => renderDdl([{ name: "Order", fields: [{ name: "id", type: "uuid", primary_key: true }] }])).toThrow("标识符");
    expect(() => renderDdl([{ name: "orders", fields: [{ name: "id", type: "varchar", primary_key: true }] }])).toThrow("类型");
    const linked = renderDdl([
      { name: "lines", fields: [{ name: "id", type: "uuid", primary_key: true }], foreign_keys: [{ columns: ["id"], ref_table: "orders", ref_columns: ["id"] }] },
      { name: "orders", fields: [{ name: "id", type: "uuid", primary_key: true }] },
    ]);
    expect(linked.indexOf('CREATE TABLE "orders"')).toBeLessThan(linked.indexOf('CREATE TABLE "lines"'));
    const repaired = renderDdl(normalizeModel([{ name: "补货单", fields: [{ name: "单号", type: "VARCHAR(40)" }, { name: "数量", type: "int" }] }]));
    expect(repaired).toContain("text");
    expect(repaired).toContain("integer");
    expect(repaired).toContain("PRIMARY KEY");
  });

  it("checks OpenAPI path parameters", () => {
    const bad = renderOpenApi("补货", [{ method: "get", path: "/orders/{id}", summary: "查看", requirement_codes: ["REQ-0001"], responses: [{ status: "200", description: "ok" }] }]);
    expect(bad.errors.join(" ")).toContain("id");
    const good = renderOpenApi("补货", [{ method: "get", path: "/orders/{id}", summary: "查看", requirement_codes: ["REQ-0001"], path_params: ["id"], responses: [{ status: "200", description: "ok" }] }]);
    expect(good.errors).toEqual([]);
    expect(good.yaml).toContain("openapi:");
  });

  it("ends every context pack with the task trailer and keeps the ingest hook", () => {
    const pack = renderContextPack({ code: "T-0001", title: "生成建议", description: "每天生成", criteria: [{ code: "AC-0001", text: "8 点前可见" }], ddl: "", openapi: "", allowed_paths: ["src/replenish/"], forbidden_paths: [".env"] });
    expect(pack.trimEnd().endsWith("SDF-Task: T-0001")).toBe(true);
    for (const target of ["gitlab", "jenkins", "azure", "gitea"] as const) {
      expect(renderPipeline(target, "npm test")).toContain("/api/public/hooks/ingest/reports");
    }
  });

  it("packs a real docx zip and skips planned blocks in the small-app workflow", () => {
    const bytes = buildDocx("需求规格说明书", [{ heading: "需求一览", table: [["编号", "标题"], ["REQ-0001", "补货建议"]] }]);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(checkMermaid("flowchart TD\n  A-->B")).toBeNull();
    expect(checkMermaid("这不是图")).toContain("Mermaid");
    const skipped = planPreview(NEW_APP_SMALL, "standard").filter((s) => s.skipped).map((s) => s.block);
    expect(skipped).toEqual([]);
  });
});
