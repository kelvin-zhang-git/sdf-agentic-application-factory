import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function storageRoot(): string {
  return process.env["SDF_STORAGE_DIR"] || path.join(process.cwd(), ".local-data", "storage");
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+/, "").slice(-120);
  if (!cleaned || cleaned.includes("..")) throw new Error("文件名不合法");
  return cleaned;
}

/** 相对路径只允许 app/source/文件名 三段，防止写出存储根目录。 */
export function resolveSourceFile(rel: string): string {
  const parts = rel.split("/").filter(Boolean);
  if (parts.length !== 3 || parts.some((p) => p === "." || p === ".." || p.includes("\\"))) throw new Error("文件路径不合法");
  const root = path.resolve(storageRoot(), "sources");
  const full = path.resolve(root, ...parts);
  if (!full.startsWith(root + path.sep)) throw new Error("文件路径不合法");
  return full;
}

export async function saveSourceBytes(rel: string, bytes: Uint8Array): Promise<void> {
  const full = resolveSourceFile(rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
}

export function sourceStream(rel: string) {
  return createReadStream(resolveSourceFile(rel));
}

export { safeName };
