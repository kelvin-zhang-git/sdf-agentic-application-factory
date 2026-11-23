import { EventEmitter } from "node:events";
import { runEngine } from "@/core/engine/runner";
import { engineStore } from "./engine-store";
import { pgSystemOps } from "./pg-system";

export const runEvents = new EventEmitter();
runEvents.setMaxListeners(0);

export function publishChange(payload: { appId?: string; runId?: string | null }) {
  runEvents.emit("changed", payload);
}

/** 在当前 Node 进程里把一个运行往前推，直到遇到等待或没有可执行步骤。 */
export function kickEngine(_origin: string, runId?: string | null) {
  const id = runId ?? null;
  setImmediate(async () => {
    try {
      for (let i = 0; i < 30; i++) {
        const result = await runEngine(engineStore, { runId: id, budgetMs: 20_000 });
        publishChange({ runId: id });
        if (!result.more) break;
      }
    } catch (error) {
      console.error("[engine]", error instanceof Error ? error.message.slice(0, 200) : "error");
    }
  });
  return "node";
}

let started = false;
export function startScheduler(): void {
  if (started || process.env["VITEST"] || process.env["SDF_DISABLE_SCHEDULER"] === "1") return;
  started = true;
  setInterval(() => {
    void (async () => {
      try {
        await engineStore.sweep();
        await runEngine(engineStore, { runId: null, budgetMs: 20_000 });
        publishChange({});
      } catch (error) {
        console.error("[sweep]", error instanceof Error ? error.message.slice(0, 200) : "error");
      }
    })();
  }, 30_000);
  setInterval(() => {
    void pgSystemOps.cleanupLogs().catch((error: unknown) => {
      console.error("[cleanup]", error instanceof Error ? error.message.slice(0, 200) : "error");
    });
  }, 60 * 60 * 1000);
}
