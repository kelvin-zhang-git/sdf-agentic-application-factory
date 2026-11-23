// 需求整理用 1、2、3 排条目，正式编号在入库时才生成。报告和导出都用这套编号对回标题。

export interface ReportReq {
  id?: string;
  code: string;
  title: string;
  priority?: string;
}

export interface ReportFinding {
  severity: string;
  description: string;
  suggestion: string;
  target_refs?: { type: string; id: string }[];
}

const CODE = /REQ-\d+(?!《|\d|（)/g;
const LABEL: Record<string, string> = { blocker: "阻断", major: "重要", minor: "建议" };

function cell(value: string): string {
  return value.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

export function catalogTable(reqs: ReportReq[]): string {
  return [
    "| 正式编号 | 需求清单标题 | 优先级 |",
    "| --- | --- | --- |",
    ...reqs.map((r) => `| ${r.code} | ${cell(r.title)} | ${r.priority ?? ""} |`),
  ].join("\n");
}

/** 按出现顺序抽出报告里的正式编号，并对照需求清单。 */
export function correspondenceRows(text: string, reqs: ReportReq[]): { code: string; title: string; priority: string; linked: boolean }[] {
  const by = new Map(reqs.map((r) => [r.code, r]));
  const seen = new Set<string>();
  const rows: { code: string; title: string; priority: string; linked: boolean }[] = [];
  for (const match of text.matchAll(CODE)) {
    const code = match[0];
    if (seen.has(code)) continue;
    seen.add(code);
    const hit = by.get(code);
    rows.push({ code, title: hit?.title ?? "", priority: hit?.priority ?? "", linked: Boolean(hit) });
  }
  return rows;
}

function annotateRequirementCodes(text: string, reqs: ReportReq[]): string {
  const by = new Map(reqs.map((r) => [r.code, r.title]));
  return text.replace(/REQ-\d+(?!《|\d|（)/g, (code) => {
    const title = by.get(code);
    return title ? `${code}《${title}》` : `${code}（需求清单中没有这个编号）`;
  });
}

/** 把需求清单标题改成「REQ-0001 标题」，并在文首放编号对照。重复执行不会叠两张表。 */
export function stampRequirementMarkdown(content: string, reqs: ReportReq[]): string {
  let next = content;
  const sorted = [...reqs].sort((a, b) => b.title.length - a.title.length);
  for (const req of sorted) {
    const title = req.title.trim();
    if (!title) continue;
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^##\\s+(?:REQ-\\d+\\s+)?(?:\\d+\\.\\s+)?${esc}\\s*$`, "m");
    next = next.replace(re, `## ${req.code} ${title}`);
  }
  if (next.includes("## 正式编号")) return next;
  const table = [
    "## 正式编号",
    "",
    "下表是写入需求库的正式编号。需求分析报告使用同一套编号，标题相同就是同一条需求。",
    "",
    catalogTable(reqs),
    "",
  ].join("\n");
  if (/^# 需求清单\s*\n/.test(next)) return next.replace(/^# 需求清单\s*\n+/, `# 需求清单\n\n${table}\n`);
  return `# 需求清单\n\n${table}\n${next}`;
}

/** 分析报告：每条发现都写明对应的正式编号和需求清单标题，不沿用模型随手写的编号。 */
export function analysisReportMarkdown(findings: ReportFinding[], reqs: ReportReq[]): string {
  const byId = new Map(reqs.flatMap((r) => (r.id ? [[r.id, r] as const] : [])));
  const count = (severity: string) => findings.filter((f) => f.severity === severity).length;
  const lines = findings.map((f) => {
    const linked = (f.target_refs ?? []).flatMap((ref) => {
      if (ref.type !== "requirement") return [];
      const hit = byId.get(ref.id);
      return hit ? [hit] : [];
    });
    const head = linked.length ? linked.map((r) => `${r.code}《${r.title}》`).join("、") : "未关联到需求清单中的条目";
    const desc = f.description.replace(/REQ-\d+/g, " ").replace(/\s{2,}/g, " ").trim();
    return `- **${LABEL[f.severity] ?? f.severity}** 对应 ${head}：${desc}\n  - 建议：${f.suggestion}`;
  });
  return [
    "# 需求分析报告",
    "",
    `阻断 ${count("blocker")}，重要 ${count("major")}，建议 ${count("minor")}`,
    "",
    "## 与需求清单的对应",
    "",
    "下表的正式编号与「需求整理」需求清单中的标题一一对应。后文只使用这些编号。",
    "",
    catalogTable(reqs),
    "",
    "## 发现",
    "",
    lines.join("\n"),
    "",
  ].join("\n");
}

/** 打开旧制品或导出 Word 时补上对应关系。已经写过对照的正文不再重复插入。 */
export function withRequirementLink(type: string, content: string, reqs: ReportReq[]): string {
  if (type === "requirements") return stampRequirementMarkdown(content, reqs);
  if (type !== "analysis") return content;
  if (content.includes("## 与需求清单的对应")) return content;
  const annotated = annotateRequirementCodes(content, reqs);
  const rows = correspondenceRows(content, reqs);
  if (!rows.length && !reqs.length) return annotated;
  const listed = rows.length ? rows : reqs.map((r) => ({ code: r.code, title: r.title, linked: true }));
  const table = [
    "## 与需求清单的对应",
    "",
    "下表把报告里的正式编号对回需求整理中的标题。标题相同，就是同一条需求。",
    "",
    "| 报告编号 | 需求清单标题 | 关系 |",
    "| --- | --- | --- |",
    ...listed.map((r) => `| ${r.code} | ${cell(r.title || "—")} | ${r.linked ? "对应需求清单" : "需求清单中没有这个编号"} |`),
    "",
  ].join("\n");
  if (/^# [^\n]+\n/.test(annotated)) return annotated.replace(/^(# [^\n]+\n+)/, `$1\n${table}\n`);
  return `${table}\n${annotated}`;
}
