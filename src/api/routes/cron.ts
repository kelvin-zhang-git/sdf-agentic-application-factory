import { Hono } from "hono";
import { AppError } from "@/core/errors";
import { verifyCron } from "@/core/scheduler";
import type { AppEnv, Deps } from "../context";
export const cronRoutes = new Hono<AppEnv>();
async function hmac(c: { req: { raw: Request; header(n: string): string | undefined } }, deps: Deps, execute: () => Promise<void>) {
  const secret = deps.env.get("SDF_CRON_SECRET");
  if (!secret) throw new AppError("FORBIDDEN", "定时任务尚未配置");
  const raw = new Uint8Array(await c.req.raw.arrayBuffer());
  await verifyCron({ raw, secret, timestamp: c.req.header("x-sdf-timestamp") ?? "", nonce: c.req.header("x-sdf-nonce") ?? "", signature: c.req.header("x-sdf-signature") ?? "", now: Math.floor(Date.now() / 1000), claim: (n) => deps.sys.claimCronNonce(n), execute });
}
cronRoutes.post("/cron", async (c) => {
  const deps = c.get("deps");
  await hmac(c, deps, () => deps.sys.cleanupLogs());
  return c.json({ ok: true });
});
/** Engine tick: signed self-chain (HMAC, size → timestamp → signature → nonce → execute) or the managed scheduler backstop. Work continues after the 202. */
cronRoutes.post("/engine-tick", async (c) => {
  const deps = c.get("deps");
  const origin = new URL(c.req.url).origin;
  if (c.req.header("authorization")) {
    const fail = await deps.managedCronAuth(c.req.raw);
    if (fail) throw new AppError("FORBIDDEN", "定时请求认证失败");
    const bg = deps.kick(origin); await deps.engine.sweep();
    return c.json({ ok: true, bg }, 202);
  }
  await hmac(c, deps, async () => { await deps.engine.sweep(); });
  const bg = deps.kick(origin);
  return c.json({ ok: true, bg }, 202);
});
