export interface ParsedFinding { rule_id: string; level: string; message: string; path: string }

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  return "";
}

/** 只读 SARIF 2.1.0 的结果列表。解析失败就拒绝，不猜测。 */
export function parseSarif(raw: string): ParsedFinding[] {
  if (raw.length > 15 * 1024 * 1024) throw new Error("报告超过 15 MB");
  const doc = JSON.parse(raw) as { runs?: { results?: { ruleId?: string; level?: string; message?: unknown; locations?: { physicalLocation?: { artifactLocation?: { uri?: string } } }[] }[] }[] };
  const runs = Array.isArray(doc.runs) ? doc.runs : [];
  return runs.flatMap((run) => (run.results ?? []).map((item) => ({
    rule_id: item.ruleId ?? "",
    level: (item.level ?? "").toLowerCase(),
    message: textOf(item.message).slice(0, 500),
    path: item.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "",
  })));
}

export function highFindingCount(findings: ParsedFinding[]): number {
  return findings.filter((item) => item.level === "error" || item.level === "critical" || item.level === "high").length;
}
