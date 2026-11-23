// B14 任务允许路径规整：将模型常见的 tests/ 统一到隔离验收扫描的 test/ 目录，并保证任务至少包含一个 test/ 路径。

function cleanPath(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function coversTestDir(path: string): boolean {
  return path === "test" || path === "test/" || path.startsWith("test/");
}

/**
 * 规整任务允许路径：
 * 1. 将 tests 或 tests/... 前缀归一化为 test/ 或 test/...；
 * 2. 去重并保留原有顺序；
 * 3. 若列表里没有任何 test/ 路径，自动补入 "test/"，避免按验收约定编写测试时触发超范围修改。
 */
export function normalizeAllowedPaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    let p = cleanPath(raw);
    if (!p) continue;
    if (p === "tests" || p === "tests/") p = "test/";
    else if (p.startsWith("tests/")) p = `test/${p.slice("tests/".length)}`;
    else if (p === "test") p = "test/";
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  if (!out.some(coversTestDir)) {
    out.push("test/");
  }
  return out;
}
