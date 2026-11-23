// @vitest-environment node
// 管理员全局指挥大盘集成测试：验证真实 PostgreSQL 聚合查询（含示例与仅真实两种模式）无 SQL 异常并清理临时用户。
import { afterAll, describe, expect, it } from "vitest";
import { serviceQuery } from "@/adapters/pg-client";
import { getApi } from "@/adapters/runtime";
import type { AdminDashboardResponse } from "@/api/routes/admin-dashboard";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] ? describe : describe.skip;
const EMAIL = "dashboard-probe@sdf.internal";
const password = `Sdf-${crypto.randomUUID()}`;

live("admin dashboard live aggregation", () => {
  let createdUser = false;

  afterAll(async () => {
    if (createdUser) {
      await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]).catch(() => undefined);
    }
  });

  it("aggregates portfolio, trends, funnel, agents, infrastructure, and audit logs", async () => {
    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]);
    const signup = await getApi().request("/api/public/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, display_name: "大盘验收探针" }),
    });
    const signed = (await signup.json()) as { access_token?: string; error?: { message?: string } };
    expect(signup.status, signed.error?.message).toBe(201);
    createdUser = true;

    const auth = { Authorization: `Bearer ${signed.access_token}` };

    // 提权前应返回 403
    const denied = await getApi().request("/api/admin/dashboard?days=14&include_seed=1", { headers: auth });
    expect(denied.status).toBe(403);

    await serviceQuery()(
      "INSERT INTO public.user_roles(user_id, role) SELECT id, 'admin' FROM auth.users WHERE email = $1 ON CONFLICT DO NOTHING",
      [EMAIL],
    );

    const resWithSeed = await getApi().request("/api/admin/dashboard?days=14&include_seed=1", { headers: auth });
    expect(resWithSeed.status).toBe(200);
    const data = (await resWithSeed.json()) as AdminDashboardResponse;
    expect(data.window_days).toBe(14);
    expect(data.include_seed).toBe(true);
    expect(data.daily_trend).toHaveLength(14);
    expect(data.sdlc_funnel).toHaveLength(6);
    expect(data.agents.length).toBeGreaterThanOrEqual(10);
    expect(data.infrastructure.blocks_total).toBe(33);

    const resUserOnly = await getApi().request("/api/admin/dashboard?days=7&include_seed=0", { headers: auth });
    expect(resUserOnly.status).toBe(200);
    const userOnly = (await resUserOnly.json()) as AdminDashboardResponse;
    expect(userOnly.window_days).toBe(7);
    expect(userOnly.include_seed).toBe(false);
    expect(userOnly.daily_trend).toHaveLength(7);
    expect(userOnly.apps.every((a) => a.source === "user")).toBe(true);
  });
});
