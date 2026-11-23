import { describe, expect, it } from "vitest";
import { createServiceDb, createUserDb } from "@/adapters/pg-client";

const run = process.env["SDF_PG_SERVICE_PASSWORD"] ? describe : describe.skip;

run("vm-9 postgres", () => {
  it("service role can see the seed apps and the first administrator is already in place", async () => {
    const db = createServiceDb();
    const boot = await db.rpc("is_bootstrapped");
    expect(boot.error).toBeNull();
    expect(boot.data).toBe(true);
    const apps = await db.from("apps").select("name").order("name");
    expect(apps.error).toBeNull();
    expect((apps.data as { name: string }[]).map((a) => a.name)).toEqual(["澄远零售门店智能补货", "门店巡检助手"]);
  });

  it("a random user is hidden from other people's apps by RLS", async () => {
    const db = createUserDb("11111111-1111-4111-8111-111111111111");
    const apps = await db.from("apps").select("id");
    expect(apps.error).toBeNull();
    expect(apps.data).toEqual([]);
  });
});
