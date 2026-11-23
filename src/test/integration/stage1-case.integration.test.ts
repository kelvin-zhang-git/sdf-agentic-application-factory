// @vitest-environment node
// 阶段 1 验收：澄远零售 6 份原始资料走完 new_app_small。不导入第 8 节，不删除已有需求和系统初始化。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { getApi } from "@/adapters/runtime";
import { serviceQuery } from "@/adapters/pg-client";
import { engineStore } from "@/adapters/engine-store";
import { runEngine } from "@/core/engine/runner";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] ? describe : describe.skip;
const EMAIL = "s1-driver@sdf.internal";
const password = `Sdf-${crypto.randomUUID()}`;
let token = "";

function api(method: string, path: string, body?: BodyInit, json = true) {
  return getApi().request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json && body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body } : {}),
  });
}

function section(md: string, from: string, to: string): string {
  const start = md.indexOf(from);
  const end = md.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`找不到章节 ${from}`);
  return md.slice(start, end).trim();
}

async function steps(runId: string) {
  return await serviceQuery()(
    "SELECT id, step_key, block_key, status, attempt, skip_reason, left(COALESCE(error->>'message',''), 300) AS error FROM public.step_runs WHERE run_id = $1 AND is_current ORDER BY seq",
    [runId],
  );
}

async function runStatus(runId: string) {
  const rows = await serviceQuery()("SELECT status FROM public.workflow_runs WHERE id = $1", [runId]);
  return String(rows[0]?.["status"] ?? "");
}

live("stage 1 chengyuan", () => {
  afterAll(async () => {
    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]).catch(() => undefined);
  }, 30_000);

  it("walks six Chengyuan sources through new_app_small to the documents", async () => {
    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]).catch(() => undefined);
    const signup = await getApi().request("/api/public/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, display_name: "阶段1验收" }),
    });
    const signed = await signup.json() as { access_token?: string; error?: { message?: string } };
    expect(signup.status, signed.error?.message).toBe(201);
    token = signed.access_token ?? "";
    await serviceQuery()(
      "INSERT INTO public.user_roles(user_id, role) SELECT id, 'admin' FROM auth.users WHERE email = $1 ON CONFLICT DO NOTHING",
      [EMAIL],
    );
    await serviceQuery()(
      "UPDATE public.workflow_runs SET started_by = (SELECT id FROM auth.users WHERE email = $1) WHERE started_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = started_by)",
      [EMAIL],
    );

    const apps = await serviceQuery()("SELECT id FROM public.apps WHERE name = $1", ["澄远零售门店智能补货"]);
    const appId = String(apps[0]?.["id"] ?? "");
    expect(appId).not.toBe("");
    const before = await serviceQuery()("SELECT count(*)::int AS n FROM public.apps", []);

    const md = readFileSync(resolve(process.cwd(), "../仿真案例-澄远零售门店智能补货.md"), "utf8");
    expect(md).toContain("## 8. 对照清单");
    const interviews: [string, string][] = [
      ["访谈：门店店长吴姐", section(md, "## 4. 访谈记录：门店店长", "## 5. 访谈记录")],
      ["访谈：仓配计划主管马磊", section(md, "## 5. 访谈记录：仓配", "## 6. 访谈记录")],
      ["访谈：财务分析经理林可", section(md, "## 6. 访谈记录：财务", "## 7. 访谈记录")],
      ["访谈：信息安全与应用架构", section(md, "## 7. 访谈记录：信息安全", "## 8. 对照清单")],
    ];
    for (const [title, text] of interviews) {
      expect(text).not.toContain("对照清单");
      const existing = await serviceQuery()("SELECT id FROM public.sources WHERE app_id = $1 AND title = $2", [appId, title]);
      if (existing.length) continue;
      const form = new FormData();
      form.set("title", title);
      form.set("kind", "interview");
      form.set("text", text);
      const uploaded = await api("POST", `/api/apps/${appId}/sources`, form, false);
      const body = await uploaded.json() as { error?: { message?: string } };
      expect(uploaded.status, body.error?.message).toBe(201);
    }

    const sources = await serviceQuery()(
      "SELECT id, title FROM public.sources WHERE app_id = $1 AND parse_status = 'parsed' ORDER BY created_at",
      [appId],
    );
    const wanted = ["工作坊纪要一", "工作坊纪要二", "访谈：门店店长", "访谈：仓配计划", "访谈：财务分析", "访谈：信息安全"];
    const sourceIds = wanted.map((prefix) => {
      const hit = sources.find((row) => String(row["title"]).includes(prefix));
      expect(hit, `缺少资料 ${prefix}`).toBeTruthy();
      return String(hit!["id"]);
    });

    const active = await serviceQuery()(
      `SELECT r.id, r.status FROM public.workflow_runs r JOIN public.workflows w ON w.id = r.workflow_id
       WHERE r.app_id = $1 AND w.key = 'new_app_small'
       ORDER BY r.started_at DESC LIMIT 1`,
      [appId],
    );
    let runId = "";
    const previous = String(active[0]?.["status"] ?? "");
    if (active.length && previous !== "completed" && previous !== "cancelled") runId = String(active[0]?.["id"]);
    if (!runId) {
      const wf = await serviceQuery()("SELECT id FROM public.workflows WHERE key = 'new_app_small' AND version = '1.0.0' AND startable", []);
      const started = await api("POST", `/api/apps/${appId}/runs`, JSON.stringify({ workflow_id: String(wf[0]?.["id"]), weight: "standard", source_ids: sourceIds }));
      const runBody = await started.json() as { id?: string; error?: { message?: string } };
      expect(started.status, runBody.error?.message).toBe(201);
      runId = runBody.id ?? "";
    }

    const retries = new Map<string, number>();
    const deadline = Date.now() + 40 * 60 * 1000;
    let rows = await steps(runId);
    while (Date.now() < deadline) {
      const status = await runStatus(runId);
      const failed = rows.find((row) => row["status"] === "failed");
      if (failed) {
        if (String(failed["error"]).includes("多次中断")) {
          await serviceQuery()(
            "UPDATE public.step_runs SET status = 'pending', error = NULL, finished_at = NULL, lease_token = NULL, lease_expires_at = NULL, lease_reclaims = 0 WHERE id = $1",
            [failed["id"]],
          );
          await serviceQuery()("SELECT public.sdf_refresh_run(run_id) FROM public.step_runs WHERE id = $1", [failed["id"]]);
          rows = await steps(runId);
          continue;
        }
        const used = retries.get(String(failed["step_key"])) ?? 0;
        if (used >= 2) throw new Error(`步骤失败：${JSON.stringify(failed)}`);
        retries.set(String(failed["step_key"]), used + 1);
        const retried = await api("POST", `/api/steps/${failed["id"]}/retry`, JSON.stringify({}));
        const retriedBody = await retried.json() as { error?: { message?: string } };
        expect(retried.status, retriedBody.error?.message).toBe(200);
        rows = await steps(runId);
        continue;
      }
      if (status === "completed" || status === "cancelled") break;
      const waiting = rows.find((row) => row["status"] === "waiting_human");
      if (waiting) {
        if (waiting["block_key"] === "B03") {
          const blockers = await serviceQuery()(
            "SELECT id FROM public.analysis_findings WHERE step_run_id = $1 AND status = 'open' AND severity = 'blocker'",
            [waiting["id"]],
          );
          for (const finding of blockers) {
            const closed = await api("PATCH", `/api/findings/${finding["id"]}`, JSON.stringify({ status: "resolved" }));
            expect(closed.status).toBe(200);
          }
        }
        const decided = await api("POST", `/api/steps/${waiting["id"]}/decide`, JSON.stringify({ decision: "approve", comment: "阶段 1 验收确认", goto: null }));
        const decidedBody = await decided.json() as { error?: { message?: string } };
        expect(decided.status, decidedBody.error?.message).toBe(200);
      }
      const model = rows.find((row) => row["status"] === "waiting_model");
      if (model) {
        const reason = await serviceQuery()("SELECT wait_reason FROM public.step_runs WHERE id = $1", [model["id"]]);
        if (reason[0]?.["wait_reason"] === "model_not_configured") throw new Error(`模型未配置：${model["step_key"]}`);
      }
      const busy = rows.some((row) => ["pending", "running", "waiting_human", "waiting_model", "waiting_event"].includes(String(row["status"])));
      if (!busy) break;
      console.log(rows.map((row) => `${row["step_key"]}:${row["status"]}`).join(" "));
      await engineStore.sweep();
      const pushed = await runEngine(engineStore, { runId, budgetMs: 90_000 });
      if (pushed.steps === 0) await new Promise((resolve) => setTimeout(resolve, 3000));
      rows = await steps(runId);
    }
    expect(await runStatus(runId), JSON.stringify(rows)).toBe("completed");
    const skipped = rows.filter((row) => row["status"] === "skipped").map((row) => row["block_key"]);
    expect(skipped).toEqual(["B15", "B20", "B21"]);

    const ddl = await serviceQuery()(
      "SELECT content FROM public.artifacts WHERE app_id = $1 AND type = 'data_model' AND key = 'main' AND is_latest",
      [appId],
    );
    const schemaPath = resolve(process.cwd(), "deploy/vm9/sql/s1_schema.sql");
    writeFileSync(schemaPath, String(ddl[0]?.["content"] ?? ""), "utf8");
    execFileSync("python", ["deploy/vm9/exec_ddl.py", schemaPath], { stdio: "inherit" });

    const proto = await api("GET", `/api/apps/${appId}/prototype`);
    const protoBody = await proto.json() as { item?: { version: number; content: string } | null };
    expect(proto.status).toBe(200);
    expect(protoBody.item?.content ?? "").toContain("<");
    const ui = readFileSync(resolve(process.cwd(), "src/components/sdf/Stage1Panels.tsx"), "utf8");
    expect(ui).toContain('sandbox="allow-scripts"');
    expect(ui.includes("allow-same-origin")).toBe(false);
    const noted = await api("POST", `/api/apps/${appId}/prototype/comments`, JSON.stringify({ anchor: "order-list", body: "确认按钮要固定在页面下方，改数量要能直接输入。" }));
    expect(noted.status).toBe(200);
    const revised = await api("POST", `/api/apps/${appId}/prototype/revise`);
    const revisedBody = await revised.json() as { error?: { message?: string } };
    expect(revised.status, revisedBody.error?.message).toBe(200);
    const proto2 = await serviceQuery()(
      "SELECT max(version)::int AS version FROM public.artifacts WHERE app_id = $1 AND type = 'prototype_html' AND key = 'main'",
      [appId],
    );
    expect(Number(proto2[0]?.["version"] ?? 0)).toBeGreaterThanOrEqual(2);

    const tasks = await serviceQuery()(
      "SELECT t.code, a.content FROM public.tasks t JOIN public.artifacts a ON a.id = t.context_artifact_id WHERE t.app_id = $1 ORDER BY t.code",
      [appId],
    );
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      const content = String(task["content"]);
      expect(content.trimEnd().endsWith(`SDF-Task: ${task["code"]}`)).toBe(true);
      expect(content).toContain("## 允许修改");
    }

    const docs = await serviceQuery()(
      "SELECT id, type FROM public.artifacts WHERE app_id = $1 AND type IN ('document_srs','document_design') AND is_latest ORDER BY type",
      [appId],
    );
    expect(docs.map((row) => row["type"])).toEqual(["document_design", "document_srs"]);
    for (const doc of docs) {
      const exported = await api("GET", `/api/artifacts/${doc["id"]}/export.docx`, undefined, false);
      expect(exported.status).toBe(200);
      const bytes = new Uint8Array(await exported.arrayBuffer());
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);
      const xml = strFromU8(unzipSync(bytes)["word/document.xml"]!);
      expect(xml).toContain("<w:tbl>");
      expect(xml).toContain("REQ-");
    }

    const after = await serviceQuery()("SELECT count(*)::int AS n FROM public.apps", []);
    expect(after[0]?.["n"]).toBe(before[0]?.["n"]);
  }, 45 * 60 * 1000);
});
