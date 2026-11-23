import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { serviceQuery } from "@/adapters/pg-client";
import type { UserDb } from "@/adapters/pg-query";
import { dbFail, requireAdmin } from "../middleware";
import { parseUuid } from "../validate";
import type { AppEnv } from "../context";
export const exampleRoutes = new Hono<AppEnv>();

export async function disabledBlockIds(db: UserDb): Promise<string[]> {
  const result = await db.from("example_catalog").select("id").eq("kind", "block").eq("enabled", false);
  dbFail(result.error);
  return (result.data ?? []).map((row) => String(row.id));
}

exampleRoutes.patch("/catalog/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  if (!/^B\d{2}$/.test(id)) throw new AppError("VALIDATION", "只能启停积木");
  const body = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AppError("VALIDATION", "请指定是否启用");
  const rows = await serviceQuery()(
    "UPDATE public.example_catalog SET enabled = $2 WHERE id = $1 AND kind = 'block' RETURNING id",
    [id, body.data.enabled],
  );
  if (!rows.length) throw new AppError("NOT_FOUND", "积木不存在");
  await c.get("deps").sys.writeAudit({
    trace_id: c.get("traceId"), actor_id: c.get("userId"), action: "block.toggled",
    target_type: "block", target_id: id, detail: { enabled: body.data.enabled },
  });
  return c.json({ id, enabled: body.data.enabled });
});

exampleRoutes.get("/catalog", async (c) => {
  const kind = z.enum(["block", "agent"]).safeParse(c.req.query("kind"));
  if (!kind.success) throw new AppError("VALIDATION", "目录类型不正确");
  const result = await c.get("db").from("example_catalog").select("*").eq("kind", kind.data).order("id");
  dbFail(result.error); return c.json({ items: result.data ?? [] });
});
exampleRoutes.get("/apps/:id/artifacts", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const app = await c.get("db").from("apps").select("id").eq("id", id).maybeSingle();
  dbFail(app.error); if (!app.data) throw new AppError("NOT_FOUND", "应用不存在或您没有访问权限");
  const result = await c.get("db").from("example_artifacts").select("*").eq("app_id", id).order("title").order("version");
  dbFail(result.error); return c.json({ items: result.data ?? [] });
});