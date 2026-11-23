// 把已经入库的测试用例写成可导出的文档，并补进各任务的开发包。
import { randomUUID } from "node:crypto";
import { serviceQuery } from "./pg-client";
import { fillCaseGaps, renderTestDesign, type CaseKind, type CaseRequirement, type DesignedCase } from "@/core/design/test-design";

function asSteps(value: unknown): string[] {
  if (typeof value === "string") {
    try { return asSteps(JSON.parse(value) as unknown); } catch { return value ? [value] : []; }
  }
  return Array.isArray(value) ? value.map((step) => String(step)).filter((step) => step.length > 0) : [];
}

function jsonbLiteral(value: unknown): string {
  // postgres.js 会把 JSON 字符串再包一层，这里直接写成 SQL 字面量。
  const tag = `js${randomUUID().replace(/-/g, "")}`;
  return `$${tag}$${JSON.stringify(value)}$${tag}$::jsonb`;
}

function asKind(value: string): CaseKind | null {
  return value === "normal" || value === "exception" || value === "boundary" ? value : null;
}

export async function publishTestDesign(appId: string, actorId: string | null): Promise<{ cases: number; created: number; artifact_id: string }> {
  const sql = serviceQuery();
  await sql(
    `UPDATE public.test_cases SET steps = (steps #>> '{}')::jsonb WHERE app_id = $1 AND jsonb_typeof(steps) = 'string'`,
    [appId],
  );
  const app = await sql(`SELECT name FROM public.apps WHERE id = $1`, [appId]);
  if (!app[0]) throw new Error("应用不存在");
  const criteria = await sql(
    `SELECT r.code AS requirement_code, r.title, a.code AS ac_code, a.text
     FROM public.requirements r
     JOIN public.acceptance_criteria a ON a.requirement_id = r.id AND a.requirement_version = r.current_version
     WHERE r.app_id = $1 AND r.status <> 'deprecated'
     ORDER BY r.code, a.code`,
    [appId],
  );
  const existing = await sql(
    `SELECT r.code AS requirement_code, t.ac_code, t.kind, t.title, t.preconditions, t.steps, t.expected
     FROM public.test_cases t
     JOIN public.requirements r ON r.id = t.requirement_id
     WHERE t.app_id = $1`,
    [appId],
  );
  const stored: DesignedCase[] = existing.flatMap((row) => {
    const kind = asKind(String(row["kind"]));
    if (!kind) return [];
    return [{
      requirement_code: String(row["requirement_code"]),
      ac_code: String(row["ac_code"]),
      kind,
      title: String(row["title"]),
      preconditions: String(row["preconditions"] ?? ""),
      steps: asSteps(row["steps"]),
      expected: String(row["expected"] ?? ""),
    }];
  });
  const reqs = new Map<string, CaseRequirement>();
  for (const row of criteria) {
    const code = String(row["requirement_code"]);
    const req = reqs.get(code) ?? { code, title: String(row["title"]), criteria: [] };
    req.criteria.push({ code: String(row["ac_code"]), text: String(row["text"]) });
    reqs.set(code, req);
  }
  const filled = fillCaseGaps([...reqs.values()], stored);
  const have = new Set(stored.map((item) => `${item.requirement_code}:${item.ac_code}:${item.kind}`));
  const missing = filled.filter((item) => !have.has(`${item.requirement_code}:${item.ac_code}:${item.kind}`));
  for (const item of missing) {
    const req = await sql(`SELECT id FROM public.requirements WHERE app_id = $1 AND code = $2`, [appId, item.requirement_code]);
    if (!req[0]) continue;
    const saved = await sql(
      `INSERT INTO public.test_cases(app_id, code, requirement_id, ac_code, kind, title, preconditions, steps, expected)
       VALUES ($1, public.next_code($1, 'TC'), $2, $3, $4, $5, $6, ${jsonbLiteral(item.steps)}, $7)
       RETURNING code`,
      [appId, req[0]["id"], item.ac_code, item.kind, item.title, item.preconditions, item.expected],
    );
    const code = String(saved[0]?.["code"] ?? "");
    if (code) {
      await sql(
        `INSERT INTO public.trace_links(app_id, from_kind, from_code, to_kind, to_code)
         VALUES ($1, 'ac', $2, 'test_case', $3)
         ON CONFLICT DO NOTHING`,
        [appId, item.ac_code, code],
      );
    }
  }
  const content = renderTestDesign(String(app[0]["name"]), filled);
  const step = await sql(
    `SELECT id FROM public.step_runs
     WHERE app_id = $1 AND block_key = 'B18' AND status = 'succeeded'
     ORDER BY finished_at DESC NULLS LAST
     LIMIT 1`,
    [appId],
  );
  const stepId = step[0]?.["id"] ? String(step[0]["id"]) : null;
  const artifact = await sql(
    `SELECT public.sdf_write_artifact($1, ${jsonbLiteral({ type: "test_design", key: "main", title: "测试用例", content, agent_role: "qa", confidence: 0.8 })}, $2, $3, 'agent')::text AS id`,
    [appId, stepId, actorId],
  );
  const artifactId = String(artifact[0]?.["id"] ?? "");
  if (stepId && artifactId) {
    await sql(
      `UPDATE public.step_runs
       SET output_artifacts = COALESCE(output_artifacts, '[]'::jsonb) || jsonb_build_array($2::text)
       WHERE id = $1 AND NOT COALESCE(output_artifacts, '[]'::jsonb) @> jsonb_build_array($2::text)`,
      [stepId, artifactId],
    );
  }
  const packs = await sql(
    `SELECT t.code, t.requirement_codes, a.id AS artifact_id, a.content
     FROM public.tasks t
     JOIN public.artifacts a ON a.id = t.context_artifact_id
     WHERE t.app_id = $1`,
    [appId],
  );
  for (const pack of packs) {
    const codes = (pack["requirement_codes"] as string[] | null) ?? [];
    const mine = filled.filter((item) => codes.includes(item.requirement_code));
    if (!mine.length) continue;
    const contentText = String(pack["content"] ?? "");
    if (contentText.includes("## 测试用例")) continue;
    const marker = contentText.lastIndexOf("\nSDF-Task:");
    if (marker < 0) continue;
    const section = ["", "## 测试用例", ...mine.map((item) => `- ${item.ac_code} ${item.kind === "normal" ? "正常" : item.kind === "boundary" ? "边界" : "例外"}：${item.title}\n  期望：${item.expected}\n  步骤：${item.steps.join("；")}`), ""].join("\n");
    await sql(`UPDATE public.artifacts SET content = $2 WHERE id = $1`, [pack["artifact_id"], contentText.slice(0, marker) + section + contentText.slice(marker)]);
  }
  return { cases: filled.length, created: missing.length, artifact_id: artifactId };
}
