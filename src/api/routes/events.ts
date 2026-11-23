import { streamSSE } from "hono/streaming";
import { Hono } from "hono";
import { runEvents } from "@/adapters/scheduler-node";
import type { AppEnv } from "../context";

export const eventRoutes = new Hono<AppEnv>();

eventRoutes.get("/events", (c) => {
  const db = c.get("db");
  return streamSSE(c, async (stream) => {
    const onChange = async (payload: { appId?: string; runId?: string | null }) => {
      if (payload.appId) {
        const seen = await db.from("apps").select("id").eq("id", payload.appId).maybeSingle();
        if (!seen.data) return;
      }
      await stream.writeSSE({ event: "changed", data: JSON.stringify({ appId: payload.appId ?? null, runId: payload.runId ?? null }) });
    };
    runEvents.on("changed", onChange);
    const beat = setInterval(() => { void stream.writeSSE({ event: "ping", data: "{}" }); }, 20_000);
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(beat);
        runEvents.off("changed", onChange);
        resolve();
      });
    });
  });
});
