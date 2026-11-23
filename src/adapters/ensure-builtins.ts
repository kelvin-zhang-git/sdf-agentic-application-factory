import { stringify } from "yaml";
import { BUILTIN_WORKFLOWS } from "@/core/engine/builtin";
import { createServiceDb } from "./pg-client";

let pending: Promise<void> | null = null;

/** 内置工作流只插一次。已有同 key、同版本时不改，避免触发不可变保护。 */
export function ensureBuiltinWorkflows(): Promise<void> {
  pending ??= seed().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

async function seed(): Promise<void> {
  const db = createServiceDb();
  for (const item of BUILTIN_WORKFLOWS) {
    const existing = await db.from("workflows").select("id").eq("key", item.def.key).eq("version", item.version).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) continue;
    const inserted = await db.from("workflows").insert({
      key: item.def.key,
      version: item.version,
      name: item.def.name,
      description: item.description,
      yaml: stringify(item.def),
      definition: item.def,
      is_builtin: true,
      startable: item.startable,
    });
    if (inserted.error) throw new Error(inserted.error.message);
  }
}
