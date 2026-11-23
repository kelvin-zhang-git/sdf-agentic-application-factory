import { describe, expect, it } from "vitest";
import { createDb } from "@/adapters/pg-query";

describe("pg query builder", () => {
  it("binds filters and keeps identifiers out of the value slots", async () => {
    let seen = "";
    const db = createDb(async (sql, params) => { seen = sql; expect(params).toEqual(["internal"]); return [{ row: { id: "1" } }]; });
    const res = await db.from("apps").select("id,name").eq("classification", "internal").maybeSingle();
    expect(res.error).toBeNull();
    expect(res.data).toEqual({ id: "1" });
    expect(seen).toContain('public."apps"');
    expect(seen).toContain("$1");
    expect(seen).not.toContain("internal");
  });

  it("keeps update values and filters in the same parameter order", async () => {
    let seen = "";
    let args: unknown[] = [];
    const db = createDb(async (sql, params) => { seen = sql; args = params ?? []; return []; });
    await db.from("step_runs").update({ lease_expires_at: "PAST", wait_reason: "rate_limited" }).eq("id", "ID");
    expect(seen).toContain('SET "lease_expires_at" = $2, "wait_reason" = $3 WHERE parent."id" = $1');
    expect(args).toEqual(["ID", "PAST", "rate_limited"]);
  });

  it("rejects identifiers that are not plain names", async () => {
    const db = createDb(async () => []);
    const res = await db.from("apps").select("id;drop").maybeSingle();
    expect(res.error?.message).toContain("非法");
  });

  it("counts related rows as a one-element array", async () => {
    let seen = "";
    const db = createDb(async (sql) => { seen = sql; return [{ row: { id: "a", app_members: [{ count: 2 }] } }]; });
    await db.from("apps").select("id, app_members(count)");
    expect(seen).toContain("count(*)::int");
    expect(seen).toContain('public."app_members"');
  });
});