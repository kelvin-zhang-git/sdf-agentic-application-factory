// 多 MR 并行时的测试与扫描报告聚合。整库 CI 报告若比所有活跃 MR 报告更新，则以整库报告为准。

export interface ReportMeta {
  id: string;
  merge_request_id: string | null;
  created_at: string | Date;
}

export interface RawTestRow {
  report_id: string;
  name: string;
  ac_code: string | null;
  status: string;
  created_at?: string | Date;
}

export interface RawFindingRow {
  report_id: string;
  rule_id: string;
  level: string;
  message: string;
  path: string;
}

function toMs(value: string | Date | undefined): number {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 选出同一种类（junit 或 sarif）当前生效的报告 ID 列表：
 * - 若存在全量报告（merge_request_id 为空），且没有任何活跃 MR 报告比它更新，则只采用最新一条全量报告；
 * - 否则，对每个活跃 MR（state IN ('open','merged')）各取最新一条报告；
 * - 若不存在活跃 MR 报告，但有历史全量报告，仍退回最新一条全量报告（兼容存量数据）。
 */
export function selectEffectiveReportIds(reports: ReportMeta[], activeMrIds: Set<string>): string[] {
  if (!reports.length) return [];
  const sorted = [...reports].sort((a, b) => toMs(b.created_at) - toMs(a.created_at));
  const latestWhole = sorted.find((item) => item.merge_request_id === null) ?? null;

  const latestByMr = new Map<string, ReportMeta>();
  for (const item of sorted) {
    if (!item.merge_request_id || !activeMrIds.has(item.merge_request_id)) continue;
    if (!latestByMr.has(item.merge_request_id)) latestByMr.set(item.merge_request_id, item);
  }

  if (latestByMr.size === 0) {
    return latestWhole ? [latestWhole.id] : [];
  }

  let newestMrTime = 0;
  for (const item of latestByMr.values()) {
    const t = toMs(item.created_at);
    if (t > newestMrTime) newestMrTime = t;
  }

  if (latestWhole && toMs(latestWhole.created_at) >= newestMrTime) {
    return [latestWhole.id];
  }

  return [...latestByMr.values()].map((item) => item.id);
}

/** 合并多份报告里的测试结果，同一用例保留较新报告中的结果。 */
export function dedupeTests(rows: RawTestRow[], reportOrder: string[]): RawTestRow[] {
  const rank = new Map<string, number>(reportOrder.map((id, index) => [id, index]));
  // reportOrder 按新到旧排序，rank 越小越新
  const ordered = [...rows].sort((a, b) => {
    const ra = rank.get(a.report_id) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.report_id) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return toMs(b.created_at) - toMs(a.created_at);
  });
  const seen = new Set<string>();
  const out: RawTestRow[] = [];
  for (const row of ordered) {
    const key = `${row.ac_code ?? ""}::${row.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** 合并多份 SARIF 报告中的扫描问题，按规则、路径、级别和描述去重。 */
export function dedupeFindings(rows: RawFindingRow[]): RawFindingRow[] {
  const seen = new Set<string>();
  const out: RawFindingRow[] = [];
  for (const row of rows) {
    const key = `${row.rule_id}::${row.path}::${row.level}::${row.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
