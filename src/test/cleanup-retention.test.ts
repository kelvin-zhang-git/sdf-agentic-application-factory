import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const sql = readFileSync("drizzle/migrations/0006_sdf_cleanup_acceptance.sql", "utf8");
describe("database cleanup retention contract", () => {
  it("retains logs for 30 days", () => { expect(sql).toMatch(/public\.app_logs[\s\S]*?created_at < pg_catalog\.now\(\)-interval '30 days'/); expect(sql).toMatch(/public\.client_errors[\s\S]*?created_at < pg_catalog\.now\(\)-interval '30 days'/); });
  it("retains replay nonces for 15 minutes", () => { expect(sql).toMatch(/public\.cron_nonces[\s\S]*?seen_at < pg_catalog\.now\(\)-interval '15 minutes'/); });
  it("bounds each deletion to 1000 rows", () => { expect(sql.match(/LIMIT 1000/g)).toHaveLength(4); });
  it("denies ordinary callers the privileged cleanup function", () => { expect(sql).toContain("REVOKE ALL ON FUNCTION public.sdf_log_cleanup() FROM PUBLIC,anon,authenticated;"); });
});