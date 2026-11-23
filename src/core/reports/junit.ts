export interface ParsedTest { name: string; ac_code: string | null; status: "passed" | "failed" | "skipped" }

/** 不用 XML 解析器，避免外部实体。只抽出测试名、验收标准编号和结果。 */
export function parseJunit(xml: string): ParsedTest[] {
  if (xml.length > 15 * 1024 * 1024) throw new Error("报告超过 15 MB");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("拒绝带外部实体的报告");
  const found: ParsedTest[] = [];
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const name = /(?:\s|^)name="([^"]*)"/.exec(attrs)?.[1] ?? "未命名用例";
    const ac = /AC-\d+/.exec(name)?.[0] ?? null;
    const status = /<skipped\b/i.test(inner) ? "skipped" : /<failure\b|<error\b/i.test(inner) ? "failed" : "passed";
    found.push({ name, ac_code: ac, status });
  }
  return found;
}
