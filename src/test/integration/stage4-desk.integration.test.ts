// @vitest-environment node
// 阶段 4 前置：连接器列表不回令牌，未认领合并请求可绑定，例外放行不改检查结果，待办含通知。
import { afterAll, describe, expect, it } from "vitest";
import { serviceQuery } from "@/adapters/pg-client";
import { getApi } from "@/adapters/runtime";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] ? describe : describe.skip;
const APP = "交付台验收";
const LEAD = "s4-lead@sdf.internal";
const BUSINESS = "s4-biz@sdf.internal";
const leadPassword = `Sdf-${crypto.randomUUID()}`;
const businessPassword = `Sdf-${crypto.randomUUID()}`;

live("stage 4 desk", () => {
  const created = { appId: "", connectorId: "", lead: false, business: false };

  afterAll(async () => {
    if (created.appId) await serviceQuery()("DELETE FROM public.apps WHERE id = $1", [created.appId]).catch(() => undefined);
    if (created.connectorId) await serviceQuery()("DELETE FROM public.connectors WHERE id = $1", [created.connectorId]).catch(() => undefined);
    if (created.lead) await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [LEAD]).catch(() => undefined);
    if (created.business) await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [BUSINESS]).catch(() => undefined);
  });

  it("lists connectors without secrets, binds a merge request, waives a gate, and marks a notice read", async () => {
    await serviceQuery()("DELETE FROM public.apps WHERE name = $1", [APP]);
    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [LEAD]);
    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [BUSINESS]);

    const leadToken = await signup(LEAD, leadPassword, "阶段4负责人");
    created.lead = true;
    await serviceQuery()("INSERT INTO public.user_roles(user_id, role) SELECT id, 'admin' FROM auth.users WHERE email = $1 ON CONFLICT DO NOTHING", [LEAD]);
    const leadAuth = { Authorization: `Bearer ${leadToken}`, "content-type": "application/json" };
    const appRes = await getApi().request("/api/apps", { method: "POST", headers: leadAuth, body: JSON.stringify({ name: APP, classification: "internal" }) });
    const app = await appRes.json() as { id?: string; error?: { message?: string } };
    expect(appRes.status, app.error?.message).toBe(201);
    created.appId = app.id ?? "";

    const connector = await serviceQuery()(
      `INSERT INTO public.connectors(capability, vendor, name, config, status)
       VALUES ('code_repo', 'gitea', '交付台仓库', '{"base_url":"http://127.0.0.1:9"}'::jsonb, 'untested') RETURNING id`,
    );
    created.connectorId = String(connector[0]?.["id"] ?? "");
    await serviceQuery()(
      "INSERT INTO public.app_connectors(app_id, connector_id, capability, binding) VALUES ($1,$2,'code_repo','{}'::jsonb)",
      [created.appId, created.connectorId],
    );
    await serviceQuery()("INSERT INTO public.tasks(app_id, code, title) VALUES ($1, 'T-9001', '交付台任务')", [created.appId]);
    const merge = await serviceQuery()(
      `INSERT INTO public.merge_requests(app_id, connector_id, external_id, title, state)
       VALUES ($1, $2, 'desk-mr', '未认领的合并请求', 'open') RETURNING id`,
      [created.appId, created.connectorId],
    );
    const mergeId = String(merge[0]?.["id"] ?? "");
    await serviceQuery()(
      `INSERT INTO public.gate_results(app_id, template_key, item_key, status, evidence)
       VALUES ($1, 'release', 'ac_coverage', 'NOT_EXECUTED', '还没有报告')`,
      [created.appId],
    );
    const users = await serviceQuery()("SELECT id FROM auth.users WHERE email = $1", [LEAD]);
    const leadId = String(users[0]?.["id"] ?? "");
    const notice = await serviceQuery()(
      "INSERT INTO public.notifications(app_id, user_id, title, body) VALUES ($1, $2, '交付台通知', '请看一眼') RETURNING id",
      [created.appId, leadId],
    );

    const listed = await getApi().request("/api/connectors", { headers: leadAuth });
    const connectors = await listed.json() as { items?: Record<string, unknown>[] };
    expect(listed.status).toBe(200);
    const mine = (connectors.items ?? []).find((row) => row["id"] === created.connectorId);
    expect(mine?.["name"]).toBe("交付台仓库");
    for (const row of connectors.items ?? []) {
      expect(row).not.toHaveProperty("secret_id");
      expect(row).not.toHaveProperty("token");
    }

    const bound = await getApi().request(`/api/apps/${created.appId}/merge-requests/${mergeId}/bind`, {
      method: "POST", headers: leadAuth, body: JSON.stringify({ task_code: "T-9001" }),
    });
    expect(bound.status).toBe(200);
    const claimed = await serviceQuery()(
      "SELECT matched_by, task_id FROM public.merge_requests WHERE id = $1",
      [mergeId],
    );
    expect(claimed[0]?.["matched_by"]).toBe("manual");
    expect(claimed[0]?.["task_id"]).toBeTruthy();

    const waived = await getApi().request(`/api/apps/${created.appId}/gates/waive`, {
      method: "POST", headers: leadAuth, body: JSON.stringify({ item_key: "ac_coverage", reason: "这次没有报告，先放行" }),
    });
    expect(waived.status).toBe(200);
    const gate = await serviceQuery()(
      "SELECT status, waiver_reason FROM public.gate_results WHERE app_id = $1 AND item_key = 'ac_coverage'",
      [created.appId],
    );
    expect(gate[0]?.["status"]).toBe("NOT_EXECUTED");
    expect(gate[0]?.["waiver_reason"]).toBe("这次没有报告，先放行");

    const businessToken = await signup(BUSINESS, businessPassword, "阶段4业务");
    created.business = true;
    const businessId = await serviceQuery()("SELECT id FROM auth.users WHERE email = $1", [BUSINESS]);
    await serviceQuery()(
      "INSERT INTO public.app_members(app_id, user_id, role) VALUES ($1, $2, 'business')",
      [created.appId, businessId[0]?.["id"]],
    );
    const businessAuth = { Authorization: `Bearer ${businessToken}`, "content-type": "application/json" };
    const hidden = await getApi().request(`/api/apps/${created.appId}/merge-requests`, { headers: businessAuth });
    expect(hidden.status).toBe(403);
    const denied = await getApi().request(`/api/apps/${created.appId}/gates/waive`, {
      method: "POST", headers: businessAuth, body: JSON.stringify({ item_key: "ac_coverage", reason: "业务方不能放行" }),
    });
    expect(denied.status).toBe(403);

    const before = await getApi().request("/api/inbox", { headers: leadAuth });
    const inbox = await before.json() as { notices?: { id: string }[]; changes?: unknown[]; feedback?: unknown[]; uat?: unknown[] };
    expect(before.status).toBe(200);
    expect(Array.isArray(inbox.changes) && Array.isArray(inbox.feedback) && Array.isArray(inbox.uat)).toBe(true);
    const noticeId = String(notice[0]?.["id"] ?? "");
    expect((inbox.notices ?? []).some((row) => row.id === noticeId)).toBe(true);
    const read = await getApi().request(`/api/notifications/${noticeId}/read`, { method: "POST", headers: leadAuth });
    expect(read.status).toBe(200);
    const after = await getApi().request("/api/inbox", { headers: leadAuth });
    const next = await after.json() as { notices?: { id: string }[] };
    expect((next.notices ?? []).some((row) => row.id === noticeId)).toBe(false);
  });
});

async function signup(email: string, password: string, displayName: string): Promise<string> {
  const response = await getApi().request("/api/public/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, display_name: displayName }),
  });
  const body = await response.json() as { access_token?: string; error?: { message?: string } };
  expect(response.status, body.error?.message).toBe(201);
  return body.access_token ?? "";
}
