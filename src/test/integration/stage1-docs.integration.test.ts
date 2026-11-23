// @vitest-environment node
// 工作流已经跑完。这里只按最新需求和设计制品重写两份 Word，并核对表格。
import { afterAll, describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { documentArtifacts } from "@/core/blocks/batch3";
import { engineStore } from "@/adapters/engine-store";
import { createServiceDb, serviceQuery } from "@/adapters/pg-client";
import { getApi } from "@/adapters/runtime";
import type { BlockContext } from "@/core/blocks";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] ? describe : describe.skip;
const EMAIL = "s1-docs@sdf.internal";
const password = `Sdf-${crypto.randomUUID()}`;

live("stage 1 documents", () => {
  afterAll(async () => {
    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]).catch(() => undefined);
  });

  it("writes requirement and design docx files with tables and requirement codes", async () => {
    const apps = await serviceQuery()("SELECT id, name FROM public.apps WHERE name = $1", ["澄远零售门店智能补货"]);
    const appId = String(apps[0]?.["id"] ?? "");
    const appName = String(apps[0]?.["name"] ?? "");
    expect(appId).not.toBe("");
    const docs = await documentArtifacts({ data: { app: { id: appId, name: appName } }, store: engineStore } as BlockContext, `${appName} 把补货建议、人工确认和履约差异放在同一套流程里。`);
    const db = createServiceDb();
    for (const doc of docs) {
      const saved = await db.rpc("sdf_write_artifact", { _app: appId, _a: doc, _step: null, _actor: null, _source: "agent" });
      expect(saved.error).toBeNull();
    }

    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]).catch(() => undefined);
    const signup = await getApi().request("/api/public/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, display_name: "文档验收" }),
    });
    const signed = await signup.json() as { access_token?: string; error?: { message?: string } };
    expect(signup.status, signed.error?.message).toBe(201);
    await serviceQuery()("INSERT INTO public.user_roles(user_id, role) SELECT id, 'admin' FROM auth.users WHERE email = $1 ON CONFLICT DO NOTHING", [EMAIL]);
    const token = signed.access_token ?? "";
    const rows = await serviceQuery()(
      "SELECT id, type FROM public.artifacts WHERE app_id = $1 AND type IN ('document_srs','document_design') AND is_latest ORDER BY type",
      [appId],
    );
    expect(rows.map((row) => row["type"])).toEqual(["document_design", "document_srs"]);
    for (const row of rows) {
      const exported = await getApi().request(`/api/artifacts/${row["id"]}/export.docx`, { headers: { authorization: `Bearer ${token}` } });
      expect(exported.status).toBe(200);
      const bytes = new Uint8Array(await exported.arrayBuffer());
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);
      const xml = strFromU8(unzipSync(bytes)["word/document.xml"]!);
      expect(xml).toContain("<w:tbl>");
      expect(xml).toContain("REQ-");
    }
  }, 60_000);
});
