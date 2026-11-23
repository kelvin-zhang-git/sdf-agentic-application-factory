// @vitest-environment node
// 阶段 0 的 S0-03 / S0-04。跑在 vm-9 的 sdf 库上，结束后删除本次管理员和探针数据，保持尚未初始化。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApi } from "@/adapters/runtime";
import { createServiceDb, serviceQuery } from "@/adapters/pg-client";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] && process.env["SDF_BOOTSTRAP_TOKEN"] ? describe : describe.skip;
const EMAIL_A = "s003-a@sdf.internal";
const EMAIL_B = "s003-b@sdf.internal";
const password = `Sdf-${crypto.randomUUID()}`;
let owns = false;
let tokenA = "";
let tokenB = "";
let appId = "";
let runId = "";
let sourceId = "";

function api() {
  return getApi();
}
function json(method: string, path: string, token: string | null, body?: unknown) {
  return api().request(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(path.endsWith("/bootstrap") ? { "x-sdf-bootstrap-token": process.env["SDF_BOOTSTRAP_TOKEN"] ?? "" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function wipe() {
  if (appId) await serviceQuery()("DELETE FROM public.apps WHERE id = $1", [appId]);
  await serviceQuery()("DELETE FROM public.apps WHERE name = '隔离探针'", []);
  await serviceQuery()("DELETE FROM public.system_state", []);
  await serviceQuery()("DELETE FROM auth.users WHERE email IN ($1, $2)", [EMAIL_A, EMAIL_B]);
}

live("stage 0 access", () => {
  beforeAll(async () => {
    const rows = await serviceQuery()(
      "SELECT u.email AS email FROM public.system_state s LEFT JOIN auth.users u ON u.id = s.bootstrapped_by",
      [],
    );
    const email = rows[0]?.["email"] ? String(rows[0]["email"]) : "";
    if (email && !email.startsWith("s003-")) throw new Error(`系统已由 ${email} 初始化，本测试不会改动`);
    owns = true;
    await wipe();
  }, 30_000);

  afterAll(async () => {
    if (!owns) return;
    await wipe();
    const left = await serviceQuery()("SELECT public.is_bootstrapped() AS ready", []);
    expect(left[0]?.["ready"]).toBe(false);
  }, 30_000);

  it("ten concurrent bootstraps produce one admin, and a later call is closed", async () => {
    const signup = async (email: string, name: string) => {
      const res = await json("POST", "/api/public/auth/signup", null, { email, password, display_name: name });
      const body = await res.json() as { access_token?: string; error?: { message?: string } };
      expect(res.status, body.error?.message).toBe(201);
      return body.access_token ?? "";
    };
    expect((process.env["SDF_JWT_SECRET"] ?? "").length).toBeGreaterThan(16);
    tokenA = await signup(EMAIL_A, "验收甲");
    tokenB = await signup(EMAIL_B, "验收乙");
    const me = await json("GET", "/api/me", tokenA);
    expect((await me.json() as { profile?: { display_name?: string } }).profile?.display_name).toBe("验收甲");

    const calls = await Promise.all(Array.from({ length: 10 }, (_, i) => json("POST", "/api/bootstrap", i < 5 ? tokenA : tokenB, {})));
    const statuses = calls.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 410, 410, 410, 410, 410, 410, 410, 410, 410]);
    const again = await json("POST", "/api/bootstrap", tokenB, {});
    expect(again.status).toBe(410);
    const who = await serviceQuery()(
      "SELECT u.email AS email FROM public.system_state s JOIN auth.users u ON u.id = s.bootstrapped_by",
      [],
    );
    expect([EMAIL_A, EMAIL_B]).toContain(String(who[0]?.["email"]));
  }, 60_000);

  it("a non-member cannot read another account's apps, runs or files", async () => {
    const created = await json("POST", "/api/apps", tokenA, { name: "隔离探针", description: "阶段 0 验收后删除", classification: "internal" });
    const appBody = await created.json() as { id?: string; error?: { message?: string } };
    expect(created.status, appBody.error?.message).toBe(201);
    appId = appBody.id ?? "";
    const db = createServiceDb();
    const wfRows = await db.from("workflows").select("id").eq("key", "requirement_only").eq("startable", true).order("version", { ascending: false }).limit(1);
    const wf = (wfRows.data as { id: string }[])[0]!;
    const actor = (await serviceQuery()("SELECT id FROM auth.users WHERE email = $1", [EMAIL_A]))[0]?.["id"];
    const started = await db.rpc("start_run", { _app: appId, _workflow: wf.id, _weight: "light", _inputs: {}, _actor: actor, _trace: "t-s004" });
    expect(started.error).toBeNull();
    runId = String(started.data);
    sourceId = crypto.randomUUID();
    await serviceQuery()(
      `INSERT INTO public.sources (id, app_id, code, kind, title, file_path, mime, size_bytes, created_by)
       VALUES ($1, $2, 'SRC-S004', 'minutes', '隔离纪要', $3, 'text/plain', 4, $4)`,
      [sourceId, appId, `${appId}/${sourceId}/note.txt`, actor],
    );

    const hidden = await json("GET", "/api/apps", tokenB);
    expect(hidden.status).toBe(200);
    expect((await hidden.json() as { items: { id: string }[] }).items).toEqual([]);
    expect((await json("GET", `/api/runs/${runId}`, tokenB)).status).toBe(404);
    expect((await json("GET", `/api/sources/${sourceId}/download`, tokenB)).status).toBe(404);

    const visible = await json("GET", "/api/apps", tokenA);
    const names = (await visible.json() as { items: { name: string }[] }).items.map((x) => x.name);
    expect(names).toContain("隔离探针");
  }, 60_000);
});
