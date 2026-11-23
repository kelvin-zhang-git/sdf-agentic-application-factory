// 隔离验收只接受压缩包里的相对路径，避免解压到目录外面。
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { secretSarif, type WorkFile } from "./acceptance-run";

export function unsafeArchiveName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) return true;
  return normalized.split("/").includes("..");
}

const TEXT = /\.(js|mjs|cjs|ts|tsx|py|json|md|yml|yaml|toml|txt|sql|xml)$/i;

/** 只读取文本，不执行仓库里的程序。用于在扫描容器不可用时仍给出高危项数字。 */
export async function readableSources(root: string, limit = 80): Promise<WorkFile[]> {
  const files: WorkFile[] = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= limit) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!TEXT.test(entry.name)) continue;
      const info = await stat(full);
      if (info.size > 200_000) continue;
      files.push({ path: relative(root, full).replace(/\\/g, "/"), content: await readFile(full, "utf8") });
    }
  }
  await walk(root);
  return files;
}

export function secretScanOf(files: WorkFile[]): string {
  return secretSarif(files);
}

export const SEMGREP_RULES = `rules:
  - id: sdf-secret
    message: 文件中有疑似密钥或口令
    languages: [generic]
    severity: ERROR
    pattern-regex: "(?i)(password|secret|api[_-]?key)\\\\s*[:=]\\\\s*\\\\S+"
`;
