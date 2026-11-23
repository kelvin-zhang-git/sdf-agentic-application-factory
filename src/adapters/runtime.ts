// Node 运行时：Hono API 接到原生 PostgreSQL，引擎在进程内推进。
import { createApi } from "@/api/app";
import { processEnv } from "./env";
import { createUserDb } from "./pg-client";
import { authenticateCronRequest, pgAuthVerifier, pgSystemOps } from "./pg-system";
import { engineCommands, engineStore } from "./engine-store";
import { kickEngine, startScheduler } from "./scheduler-node";
import { ensureBuiltinWorkflows } from "./ensure-builtins";

let api: ReturnType<typeof createApi> | null = null;
export function getApi() {
  startScheduler();
  void ensureBuiltinWorkflows().catch((error: unknown) => {
    console.error("[workflows]", error instanceof Error ? error.message.slice(0, 200) : "error");
  });
  api ??= createApi({
    sys: pgSystemOps, auth: pgAuthVerifier, env: processEnv, userDb: createUserDb,
    engine: engineStore, commands: engineCommands, kick: kickEngine,
    managedCronAuth: authenticateCronRequest,
    pdfText: async (bytes) => { const { extractText, getDocumentProxy } = await import("unpdf"); const pdf = await getDocumentProxy(bytes); const r = await extractText(pdf, { mergePages: true }); return Array.isArray(r.text) ? r.text.join("\n") : r.text; },
  });
  return api;
}
