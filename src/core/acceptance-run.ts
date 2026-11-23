// 阶段 1 的验收运行：只运行本平台生成的工程文件，并做一次密钥扫描。
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface WorkFile { path: string; content: string }

export function editRatio(before: string, after: string): number {
  const max = Math.max(before.length, after.length);
  if (max === 0) return 0;
  let diff = Math.abs(before.length - after.length);
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i += 1) if (before.charCodeAt(i) !== after.charCodeAt(i)) diff += 1;
  return Math.min(1, Number((diff / max).toFixed(4)));
}

/** 拒绝跳出工作目录的路径。 */
export function safeJoin(root: string, rel: string): string {
  if (rel.includes("\0") || rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel)) {
    throw new Error("文件路径不在工程目录内");
  }
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) throw new Error("文件路径不在工程目录内");
  return full;
}

/** 在生成的文件里查找疑似密钥，结果写成 SARIF，供现有的扫描导入使用。 */
export function secretSarif(files: WorkFile[]): string {
  const results = files.flatMap((file) => {
    const hit = /sk-[A-Za-z0-9_-]{8,}/.test(file.content) || /(password|secret|api[_-]?key)\s*[:=]\s*\S+/i.test(file.content);
    if (!hit) return [];
    return [{
      ruleId: "sdf-secret",
      level: "error",
      message: { text: "文件中有疑似密钥或口令" },
      locations: [{ physicalLocation: { artifactLocation: { uri: file.path } } }],
    }];
  });
  return JSON.stringify({ version: "2.1.0", runs: [{ results }] });
}

export function acceptanceTestSource(cases: { name: string }[]): string {
  const body = cases.map((item) => `test(${JSON.stringify(item.name)}, () => { assert.equal(start().ok, true); });`).join("\n");
  return `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { start } from "../src/server.js";\n${body || 'test("工程可以启动", () => { assert.equal(start().ok, true); });'}\n`;
}

/** 在临时目录里用当前 Node 运行测试，返回 JUnit XML。测试失败时仍然返回报告。 */
export async function runNodeTests(files: WorkFile[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sdf-acc-"));
  try {
    for (const file of files) {
      const full = safeJoin(root, file.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.content, "utf8");
    }
    const xmlPath = join(root, "junit.xml");
    const code = await new Promise<number>((resolvePromise, reject) => {
      const child = spawn(process.execPath, ["--test", "--test-reporter=junit", "--test-reporter-destination", xmlPath, "test/acceptance.test.js"], {
        cwd: root,
        timeout: 60_000,
        env: { PATH: process.env["PATH"] ?? "", HOME: root, TEMP: root, TMP: root },
      });
      child.on("error", reject);
      child.on("close", (status) => resolvePromise(status ?? 1));
    });
    const xml = await readFile(xmlPath, "utf8").catch(() => "");
    if (!xml) throw new Error(`测试没有产生报告（退出码 ${code}）`);
    return xml;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
