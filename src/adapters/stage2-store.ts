// 阶段 2 的落库和外部调用。密钥只在这里解密，不写进日志。
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { codingSkillFiles } from "@/core/coding-skills";
import { AppError } from "@/core/errors";
import { decryptSecret } from "@/core/secret-crypto";
import { codeRepo } from "@/core/connectors/factory";
import { normalizeGiteaApiBase } from "@/core/connectors/gitea";
import { matchTask } from "@/core/connectors/match";
import { outOfScope } from "@/core/connectors/paths";
import type { CodeRepoConnector, RepoConfig } from "@/core/connectors/types";
import { evaluateGate, type GateItem } from "@/core/reports/gate";
import { dedupeFindings, dedupeTests, selectEffectiveReportIds, type RawFindingRow, type RawTestRow, type ReportMeta } from "@/core/reports/aggregate";
import { parseJunit } from "@/core/reports/junit";
import { highFindingCount, parseSarif } from "@/core/reports/sarif";
import { processEnv } from "./env";
import { serviceQuery } from "./pg-client";

interface BindingRow {
  connector_id: string;
  vendor: string;
  config: RepoConfig;
  binding: { owner?: string; repo?: string; default_branch?: string };
  secret_id: string | null;
  secret_ciphertext: string | null;
  secret_kind: string | null;
  webhook_id: string | null;
  webhook_ciphertext: string | null;
  webhook_kind: string | null;
}

async function plain(id: string | null, ciphertext: string | null, kind: string | null): Promise<string> {
  if (!id || !ciphertext || (kind !== "connector_token" && kind !== "webhook_secret" && kind !== "llm_provider")) return "";
  const key = processEnv.get("SDF_SECRET_KEY");
  if (!key) throw new AppError("SECRET_DECRYPT_FAILED", "密钥无法解密，请管理员检查 SDF_SECRET_KEY");
  return decryptSecret(ciphertext, key, id, kind);
}

async function binding(appId: string): Promise<{ row: BindingRow; repo: CodeRepoConnector; config: RepoConfig }> {
  const rows = await serviceQuery()(`
    SELECT c.id AS connector_id, c.vendor, c.config, b.binding,
           s.id AS secret_id, s.ciphertext AS secret_ciphertext, s.kind AS secret_kind,
           w.id AS webhook_id, w.ciphertext AS webhook_ciphertext, w.kind AS webhook_kind
    FROM public.app_connectors b
    JOIN public.connectors c ON c.id = b.connector_id
    LEFT JOIN public.secrets s ON s.id = c.secret_id
    LEFT JOIN public.secrets w ON w.id = c.webhook_secret_id
    WHERE b.app_id = $1 AND b.capability = 'code_repo'
    LIMIT 1`, [appId]) as unknown as BindingRow[];
  const row = rows[0];
  if (!row) throw new AppError("VALIDATION", "这个应用还没有绑定代码仓");
  const config: RepoConfig = {
    base_url: row.config.base_url,
    owner: row.binding.owner || row.config.owner,
    repo: row.binding.repo || row.config.repo,
    default_branch: row.binding.default_branch || row.config.default_branch || "main",
  };
  const token = await plain(row.secret_id, row.secret_ciphertext, row.secret_kind);
  const hook = await plain(row.webhook_id, row.webhook_ciphertext, row.webhook_kind);
  if (!token) throw new AppError("VALIDATION", "代码仓令牌无法读取，请重新保存连接器");
  return { row, config, repo: codeRepo(row.vendor, config, token, hook) };
}

/** 拉取分支压缩包。只支持当前环境使用的 Gitea。 */
export async function downloadBranchArchive(appId: string, branch: string): Promise<Buffer> {
  const linked = await binding(appId);
  if (linked.row.vendor !== "gitea") throw new AppError("VALIDATION", "隔离验收目前只拉取 Gitea 上的分支");
  const token = await plain(linked.row.secret_id, linked.row.secret_ciphertext, linked.row.secret_kind);
  const root = `${normalizeGiteaApiBase(linked.config.base_url)}/repos/${encodeURIComponent(linked.config.owner)}/${encodeURIComponent(linked.config.repo)}`;
  const response = await fetch(`${root}/archive/${encodeURIComponent(branch)}.tar.gz`, { headers: { Authorization: `token ${token}` } });
  if (!response.ok) throw new AppError("VALIDATION", "拉取分支压缩包失败");
  return Buffer.from(await response.arrayBuffer());
}

async function remember(connectorId: string, appId: string, action: string, ok: boolean, started: number, error?: string) {
  await serviceQuery()(
    `INSERT INTO public.connector_calls(connector_id, app_id, action, status, duration_ms, error_message)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [connectorId, appId, action, ok ? "success" : "error", Date.now() - started, error ?? null],
  ).catch(() => undefined);
}

export async function publishHandoff(appId: string, runId: string, runCode: string): Promise<{ branch: string; summary: string; url: string | null }> {
  const started = Date.now();
  const linked = await binding(appId);
  const tasks = await serviceQuery()(
    `SELECT t.id, t.code, t.title, t.description, t.allowed_paths, t.forbidden_paths, a.content
     FROM public.tasks t
     LEFT JOIN public.artifacts a ON a.id = t.context_artifact_id
     WHERE t.app_id = $1 AND (
      t.created_by_step IN (SELECT id FROM public.step_runs WHERE run_id = $2)
      OR NOT EXISTS (SELECT 1 FROM public.tasks t2 WHERE t2.app_id = $1 AND t2.created_by_step IN (SELECT id FROM public.step_runs WHERE run_id = $2))
    ) ORDER BY t.code`, [appId, runId],
  );
  if (!tasks.length) throw new AppError("VALIDATION", "没有可交接的任务");
  const [constitution, design, requirements, domain, appRows] = await Promise.all([
    serviceQuery()(`SELECT content FROM public.artifacts WHERE app_id = $1 AND type = 'constitution' AND is_latest ORDER BY version DESC LIMIT 1`, [appId]),
    serviceQuery()(`SELECT content FROM public.artifacts WHERE app_id = $1 AND type = 'design_doc' AND is_latest ORDER BY version DESC LIMIT 1`, [appId]),
    serviceQuery()(`SELECT code, title, story FROM public.requirements WHERE app_id = $1 ORDER BY code`, [appId]),
    serviceQuery()(`SELECT content FROM public.artifacts WHERE app_id = $1 AND type = 'domain_pack' AND is_latest ORDER BY version DESC LIMIT 1`, [appId]),
    serviceQuery()(`SELECT name FROM public.apps WHERE id = $1`, [appId]),
  ]);
  const spec = requirements.map((row) => `## ${row["code"]} ${row["title"]}\n\n${row["story"] ?? ""}`).join("\n\n");
  const taskList = tasks.map((row) => `- ${row["code"]} ${row["title"]}`).join("\n");
  const constitutionText = String(constitution[0]?.["content"] ?? "# 工程规范\n\n尚未生成。\n");
  const files = [
    { path: "CONSTITUTION.md", content: constitutionText },
    { path: "specs/app/requirements.md", content: spec || "# 需求\n\n无。\n" },
    { path: "design.md", content: String(design[0]?.["content"] ?? "# 设计\n\n尚未生成。\n") },
    { path: "tasks.md", content: `# 任务\n\n${taskList}\n` },
    ...tasks.map((row) => ({
      path: `context/${row["code"]}.md`,
      content: String(row["content"] ?? `# ${row["code"]}\n\n${row["description"] ?? ""}\n\nSDF-Task: ${row["code"]}\n`),
    })),
    ...codingSkillFiles({
      appName: String(appRows[0]?.["name"] ?? "应用"),
      constitution: constitutionText,
      domain: domain[0]?.["content"] ? String(domain[0]["content"]) : null,
    }),
  ];
  const branch = `sdf/handoff-${runCode}`;
  try {
    const saved = await linked.repo.commitFiles(branch, `交接 ${runCode}`, files);
    for (const task of tasks) {
      await serviceQuery()(
        `INSERT INTO public.handoffs(app_id, run_id, task_id, channel, branch_name, external_url, status)
         VALUES ($1,$2,$3,'repo_files',$4,$5,'sent')
         ON CONFLICT (run_id, task_id) DO UPDATE SET branch_name = EXCLUDED.branch_name, external_url = EXCLUDED.external_url, sent_at = now()`,
        [appId, runId, task["id"], branch, saved.url],
      );
    }
    await remember(linked.row.connector_id, appId, "commit_files", true, started);
    return { branch, url: saved.url, summary: `已把 ${files.length} 个文件提交到 ${branch}` };
  } catch (error) {
    await remember(linked.row.connector_id, appId, "commit_files", false, started, error instanceof Error ? error.message : "提交失败");
    throw new AppError("VALIDATION", error instanceof Error ? error.message : "提交到代码仓失败");
  }
}

export async function repoSnapshot(appId: string): Promise<{ files: { path: string; content: string }[] }> {
  const linked = await binding(appId);
  const files = await linked.repo.getTree(120_000);
  return { files };
}

interface TaskRow { id: string; code: string; allowed_paths: string[]; forbidden_paths: string[] }

async function claimOne(appId: string, connectorId: string, repo: CodeRepoConnector, item: { id: string; number: number; title: string; body: string; branch: string; url: string; state: "open" | "merged" | "closed"; author: string }) {
  const tasks = await serviceQuery()(`SELECT id, code, allowed_paths, forbidden_paths FROM public.tasks WHERE app_id = $1`, [appId]) as unknown as TaskRow[];
  const files = item.number ? await repo.getPullRequestFiles(item.number) : [];
  const matched = matchTask(item, tasks.map((task) => task.code));
  const task = tasks.find((row) => row.code === matched?.code);
  const outside = outOfScope(files, task?.allowed_paths ?? [], task?.forbidden_paths ?? [".env", "**/.env"]);
  const saved = await serviceQuery()(
    `INSERT INTO public.merge_requests(app_id, task_id, connector_id, external_id, number, url, title, branch, state, author, changed_files, out_of_scope_files, matched_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (connector_id, external_id) DO UPDATE SET task_id = EXCLUDED.task_id, state = EXCLUDED.state, changed_files = EXCLUDED.changed_files,
       out_of_scope_files = EXCLUDED.out_of_scope_files, matched_by = EXCLUDED.matched_by, updated_at = now()
     RETURNING id`,
    [appId, task?.id ?? null, connectorId, item.id, item.number, item.url, item.title, item.branch, item.state, item.author, files, outside, matched?.matched_by ?? null],
  );
  if (task && item.state !== "closed" && item.branch && saved[0]?.["id"]) {
    const { scheduleIsolatedAcceptance } = await import("./isolated-acceptance");
    scheduleIsolatedAcceptance(appId, String(saved[0]["id"]));
  }
  if (outside.length && item.number) {
    await repo.commentPullRequest(item.number, `这些文件超出任务允许修改的范围：\n${outside.map((file) => `- ${file}`).join("\n")}`).catch(() => undefined);
  }
  await wakeHandoffs(appId);
  return { matched: matched?.code ?? null, out_of_scope_files: outside };
}

/** 人工把未认领的合并请求绑到任务上，按目标任务重算越界文件并刷新交付检查。 */
export async function bindMergeRequest(appId: string, mergeId: string, taskCode: string): Promise<void> {
  const tasks = await serviceQuery()(
    "SELECT id, allowed_paths, forbidden_paths FROM public.tasks WHERE app_id = $1 AND code = $2",
    [appId, taskCode],
  );
  const task = tasks[0] as { id?: string; allowed_paths?: string[] | null; forbidden_paths?: string[] | null } | undefined;
  if (!task?.id) throw new AppError("VALIDATION", "这个应用里没有该任务编号");

  const mrs = await serviceQuery()(
    "SELECT id, number, changed_files FROM public.merge_requests WHERE id = $1 AND app_id = $2",
    [mergeId, appId],
  );
  const mr = mrs[0] as { id?: string; number?: number | null; changed_files?: string[] | null } | undefined;
  if (!mr?.id) throw new AppError("NOT_FOUND", "合并请求不存在");

  let files = Array.isArray(mr.changed_files) ? mr.changed_files : [];
  if (!files.length && mr.number && mr.number > 0) {
    try {
      const linked = await binding(appId);
      files = await linked.repo.getPullRequestFiles(mr.number);
    } catch {
      // 仓库暂时不可达时，按已有文件列表计算，不阻断人工认领。
    }
  }
  const allowed = task.allowed_paths ?? [];
  const forbidden = task.forbidden_paths?.length ? task.forbidden_paths : [".env", "**/.env"];
  const outside = outOfScope(files, allowed, forbidden);

  await serviceQuery()(
    `UPDATE public.merge_requests
     SET task_id = $3, matched_by = 'manual', changed_files = $4, out_of_scope_files = $5, updated_at = now()
     WHERE id = $1 AND app_id = $2`,
    [mergeId, appId, task.id, files, outside],
  );
  await saveGate(appId, null).catch(() => undefined);
  await wakeHandoffs(appId);
  const { scheduleIsolatedAcceptance } = await import("./isolated-acceptance");
  scheduleIsolatedAcceptance(appId, mergeId);
}

async function wakeHandoffs(appId: string): Promise<void> {
  const runs = await serviceQuery()("SELECT DISTINCT run_id FROM public.handoffs WHERE app_id = $1 AND task_id IS NOT NULL", [appId]);
  for (const run of runs) {
    const pending = await serviceQuery()(
      `SELECT 1 FROM public.handoffs h
       WHERE h.run_id = $1 AND h.task_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.merge_requests m WHERE m.task_id = h.task_id AND m.state IN ('open','merged'))
       LIMIT 1`, [run["run_id"]],
    );
    if (!pending.length) await serviceQuery()("SELECT public.resolve_wait($1, 'handoff.all_collected', '{}'::jsonb)", [run["run_id"]]);
  }
}

export async function receiveWebhook(connectorId: string, raw: string, signature: string | undefined): Promise<{ ignored?: boolean; matched: string | null; out_of_scope_files: string[] }> {
  const rows = await serviceQuery()(`
    SELECT b.app_id, c.vendor, c.config, b.binding,
           s.id AS secret_id, s.ciphertext AS secret_ciphertext, s.kind AS secret_kind,
           w.id AS webhook_id, w.ciphertext AS webhook_ciphertext, w.kind AS webhook_kind
    FROM public.app_connectors b
    JOIN public.connectors c ON c.id = b.connector_id
    LEFT JOIN public.secrets s ON s.id = c.secret_id
    LEFT JOIN public.secrets w ON w.id = c.webhook_secret_id
    WHERE c.id = $1 AND b.capability = 'code_repo'`, [connectorId]) as unknown as (BindingRow & { app_id: string })[];
  const payload = JSON.parse(raw) as { pull_request?: { id?: number; number?: number; title?: string; body?: string; html_url?: string; state?: string; merged?: boolean; head?: { ref?: string }; user?: { login?: string } }; repository?: { full_name?: string } };
  const pr = payload.pull_request;
  if (!pr) return { ignored: true, matched: null, out_of_scope_files: [] };
  const full = payload.repository?.full_name ?? "";
  const row = rows.find((item) => `${item.binding.owner}/${item.binding.repo}` === full) ?? rows[0];
  if (!row) throw new AppError("NOT_FOUND", "连接器没有绑定应用");
  const token = await plain(row.secret_id, row.secret_ciphertext, row.secret_kind);
  const hook = await plain(row.webhook_id, row.webhook_ciphertext, row.webhook_kind);
  const config: RepoConfig = { base_url: row.config.base_url, owner: row.binding.owner || "", repo: row.binding.repo || "", default_branch: row.binding.default_branch || "main" };
  const repo = codeRepo(row.vendor, config, token, hook);
  if (!repo.verifyWebhook(raw, signature)) throw new AppError("FORBIDDEN", "签名不正确");
  return claimOne(row.app_id, connectorId, repo, {
    id: String(pr.id ?? pr.number ?? ""), number: Number(pr.number ?? 0), title: pr.title ?? "", body: pr.body ?? "",
    branch: pr.head?.ref ?? "", url: pr.html_url ?? "", state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open", author: pr.user?.login ?? "",
  });
}

export async function syncPullRequests(appId: string): Promise<number> {
  const linked = await binding(appId);
  const items = await linked.repo.listPullRequests();
  for (const item of items) await claimOne(appId, linked.row.connector_id, linked.repo, item);
  return items.length;
}

export async function issueIngestToken(appId: string, name: string, userId: string): Promise<string> {
  const token = `sdfi_${randomBytes(24).toString("hex")}`;
  const hash = await bcrypt.hash(token, 12);
  await serviceQuery()(
    `INSERT INTO public.ingest_tokens(app_id, name, token_prefix, token_hash, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [appId, name, token.slice(0, 12), hash, userId],
  );
  return token;
}

async function tokenApp(header: string | undefined): Promise<string> {
  const token = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!token.startsWith("sdfi_")) throw new AppError("AUTH_INVALID", "上传令牌不正确");
  const rows = await serviceQuery()(`SELECT id, app_id, token_hash FROM public.ingest_tokens WHERE token_prefix = $1 AND revoked_at IS NULL`, [token.slice(0, 12)]);
  for (const row of rows) {
    if (await bcrypt.compare(token, String(row["token_hash"]))) {
      await serviceQuery()(`UPDATE public.ingest_tokens SET last_used_at = now() WHERE id = $1`, [row["id"]]);
      return String(row["app_id"]);
    }
  }
  throw new AppError("AUTH_INVALID", "上传令牌不正确");
}

export async function ingestReport(header: string | undefined, junit: string | null, sarif: string | null): Promise<{ app_id: string; tests: number; findings: number }> {
  return storeReports(await tokenApp(header), junit, sarif);
}

export async function storeReports(
  appId: string,
  junit: string | null,
  sarif: string | null,
  opts?: { mergeRequestId?: string | null },
): Promise<{ app_id: string; tests: number; findings: number }> {
  const mergeRequestId = opts?.mergeRequestId ?? null;
  let tests = 0;
  let findings = 0;
  if (junit) {
    const parsed = parseJunit(junit);
    const report = await serviceQuery()(
      `INSERT INTO public.reports(app_id, kind, raw_bytes, merge_request_id) VALUES ($1,'junit',$2,$3) RETURNING id`,
      [appId, Buffer.byteLength(junit), mergeRequestId],
    );
    const reportId = report[0]?.["id"];
    for (const item of parsed) {
      await serviceQuery()(`INSERT INTO public.test_results(report_id, app_id, name, ac_code, status) VALUES ($1,$2,$3,$4,$5)`, [reportId, appId, item.name, item.ac_code, item.status]);
    }
    tests = parsed.length;
  }
  if (sarif) {
    const parsed = parseSarif(sarif);
    const report = await serviceQuery()(
      `INSERT INTO public.reports(app_id, kind, raw_bytes, merge_request_id) VALUES ($1,'sarif',$2,$3) RETURNING id`,
      [appId, Buffer.byteLength(sarif), mergeRequestId],
    );
    const reportId = report[0]?.["id"];
    for (const item of parsed) {
      await serviceQuery()(`INSERT INTO public.scan_findings(report_id, app_id, rule_id, level, message, path) VALUES ($1,$2,$3,$4,$5,$6)`, [reportId, appId, item.rule_id, item.level, item.message, item.path]);
    }
    findings = parsed.length;
  }
  if (!junit && !sarif) throw new AppError("VALIDATION", "请上传 JUnit 或 SARIF 报告");
  const hook = await serviceQuery()("SELECT enabled FROM public.hooks WHERE event_key = 'report.imported'", []);
  if (hook[0]?.["enabled"] !== false) await saveGate(appId, null).catch(() => undefined);
  return { app_id: appId, tests, findings };
}

/** 选出当前应用生效的报告 ID（整库 CI 报告优先，否则按活跃 MR 各取最新）。 */
async function effectiveReportIds(appId: string, kind: "junit" | "sarif"): Promise<string[]> {
  const [reports, activeMrs] = await Promise.all([
    serviceQuery()(
      `SELECT id::text AS id, merge_request_id::text AS merge_request_id, created_at
       FROM public.reports
       WHERE app_id = $1 AND kind = $2
       ORDER BY created_at DESC
       LIMIT 200`,
      [appId, kind],
    ),
    serviceQuery()(
      `SELECT id::text AS id FROM public.merge_requests WHERE app_id = $1 AND state IN ('open', 'merged')`,
      [appId],
    ),
  ]);
  const metas: ReportMeta[] = reports.map((row) => ({
    id: String(row["id"]),
    merge_request_id: row["merge_request_id"] ? String(row["merge_request_id"]) : null,
    created_at: row["created_at"] as string | Date,
  }));
  const activeIds = new Set(activeMrs.map((row) => String(row["id"])));
  return selectEffectiveReportIds(metas, activeIds);
}

/** 读取聚合后的有效测试结果，供交付检查、失败诊断与证据包共用同一口径。 */
export async function effectiveTestResults(appId: string): Promise<{ hasReport: boolean; items: { name: string; ac_code: string | null; status: string }[] }> {
  const ids = await effectiveReportIds(appId, "junit");
  if (!ids.length) return { hasReport: false, items: [] };
  const rows = await serviceQuery()(
    `SELECT report_id::text AS report_id, name, ac_code, status
     FROM public.test_results
     WHERE report_id = ANY($1::uuid[])`,
    [ids],
  );
  const raw: RawTestRow[] = rows.map((row) => ({
    report_id: String(row["report_id"]),
    name: String(row["name"] ?? ""),
    ac_code: row["ac_code"] ? String(row["ac_code"]) : null,
    status: String(row["status"] ?? "passed"),
  }));
  const merged = dedupeTests(raw, ids);
  return {
    hasReport: true,
    items: merged.map((item) => ({ name: item.name, ac_code: item.ac_code, status: item.status })),
  };
}

/** 读取聚合后的有效安全扫描结果，供交付检查与证据包共用同一口径。 */
export async function effectiveScanFindings(appId: string): Promise<{ hasReport: boolean; items: { rule_id: string; level: string; message: string; path: string }[] }> {
  const ids = await effectiveReportIds(appId, "sarif");
  if (!ids.length) return { hasReport: false, items: [] };
  const rows = await serviceQuery()(
    `SELECT report_id::text AS report_id, rule_id, level, message, path
     FROM public.scan_findings
     WHERE report_id = ANY($1::uuid[])`,
    [ids],
  );
  const raw: RawFindingRow[] = rows.map((row) => ({
    report_id: String(row["report_id"]),
    rule_id: String(row["rule_id"] ?? ""),
    level: String(row["level"] ?? ""),
    message: String(row["message"] ?? ""),
    path: String(row["path"] ?? ""),
  }));
  const merged = dedupeFindings(raw);
  return {
    hasReport: true,
    items: merged.map((item) => ({ rule_id: item.rule_id, level: item.level, message: item.message, path: item.path })),
  };
}

export async function saveGate(appId: string, runId: string | null, templateKey = "standard"): Promise<{ met: boolean; items: GateItem[] }> {
  const templates = await serviceQuery()(`SELECT rules FROM public.gate_templates WHERE key = $1`, [templateKey]);
  const rules = (templates[0]?.["rules"] ?? { coverage_min: 0.8, pass_rate: 1, sarif_high_max: 0, out_of_scope_max: 0 }) as { coverage_min: number; pass_rate: number; sarif_high_max: number; out_of_scope_max: number };
  const release = await serviceQuery()(
    `SELECT rel.iteration_id FROM public.releases rel
     JOIN public.apps a ON a.id = rel.app_id AND a.current_version = rel.version
     WHERE a.id = $1 AND rel.iteration_id IS NOT NULL`,
    [appId],
  );
  const iterationId = release[0]?.["iteration_id"] ? String(release[0]["iteration_id"]) : null;
  const scoped = iterationId
    ? await serviceQuery()(
      `SELECT DISTINCT a.code FROM public.acceptance_criteria a
       JOIN public.requirements req ON req.id = a.requirement_id AND req.current_version = a.requirement_version
       JOIN public.feature_requirements fr ON fr.requirement_id = req.id
       JOIN public.features f ON f.id = fr.feature_id
       WHERE a.app_id = $1 AND f.iteration_id = $2`,
      [appId, iterationId],
    )
    : [];
  const scopedCodes = new Set(scoped.map((row) => String(row["code"])));
  const ac = scopedCodes.size
    ? [{ n: scopedCodes.size }]
    : await serviceQuery()(`SELECT COUNT(DISTINCT code)::int AS n FROM public.acceptance_criteria WHERE app_id = $1`, [appId]);

  const [testAgg, findingAgg] = await Promise.all([
    effectiveTestResults(appId),
    effectiveScanFindings(appId),
  ]);

  // 仅统计活跃（open/merged）合并请求，已关闭的废弃 MR 不污染超范围修改指标；
  // 若当前处于迭代作用域且该迭代下存在带 feature_id 的任务，则优先按本迭代任务过滤，保留未绑定任务或未分功能的活跃 MR。
  const iterationTasks = iterationId
    ? await serviceQuery()(
      `SELECT t.id::text AS id
       FROM public.tasks t
       JOIN public.features f ON f.id = t.feature_id
       WHERE t.app_id = $1 AND f.iteration_id = $2`,
      [appId, iterationId],
    )
    : [];
  const merges = iterationTasks.length
    ? await serviceQuery()(
      `SELECT m.out_of_scope_files
       FROM public.merge_requests m
       LEFT JOIN public.tasks t ON t.id = m.task_id
       LEFT JOIN public.features f ON f.id = t.feature_id
       WHERE m.app_id = $1
         AND m.state IN ('open', 'merged')
         AND (m.task_id IS NULL OR t.feature_id IS NULL OR f.iteration_id = $2)`,
      [appId, iterationId],
    )
    : await serviceQuery()(
      `SELECT out_of_scope_files FROM public.merge_requests WHERE app_id = $1 AND state IN ('open', 'merged')`,
      [appId],
    );

  const tests = testAgg.items;
  const findings = findingAgg.items;
  const covered = new Set(
    tests
      .map((row) => row.ac_code)
      .filter((code): code is string => typeof code === "string" && code.length > 0 && (scopedCodes.size === 0 || scopedCodes.has(code))),
  );
  const outcome = evaluateGate({
    rules, acTotal: Number(ac[0]?.["n"] ?? 0), acCovered: covered.size,
    testsTotal: tests.length, testsFailed: tests.filter((row) => row.status === "failed").length,
    hasJunit: testAgg.hasReport, hasSarif: findingAgg.hasReport,
    sarifHigh: highFindingCount(findings),
    hasMergeRequest: merges.length > 0,
    outOfScopeFiles: merges.reduce((sum, row) => sum + ((row["out_of_scope_files"] as string[] | null)?.length ?? 0), 0),
  });
  for (const item of outcome.items) {
    await serviceQuery()(
      `INSERT INTO public.gate_results(app_id, run_id, template_key, item_key, status, numerator, denominator, evidence, iteration_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [appId, runId, templateKey, item.item_key, item.status, item.numerator, item.denominator, item.evidence, iterationId],
    );
  }
  return outcome;
}

export async function failedTests(appId: string): Promise<{ name: string; ac_code: string | null }[]> {
  const { hasReport, items } = await effectiveTestResults(appId);
  if (!hasReport) return [];
  return items
    .filter((item) => item.status === "failed")
    .map((item) => ({ name: item.name, ac_code: item.ac_code }));
}

export interface ReviewPull { number: number; title: string; diff: string }
export interface ReviewMaterial { constitution: string; criteria: string; pulls: ReviewPull[] }

export async function reviewTargets(appId: string): Promise<ReviewMaterial> {
  const constitution = await serviceQuery()(
    `SELECT content FROM public.artifacts WHERE app_id = $1 AND type = 'constitution' AND key = 'main' AND is_latest ORDER BY version DESC LIMIT 1`,
    [appId],
  );
  const criteria = await serviceQuery()(
    `SELECT r.code, a.code AS ac, a.text
     FROM public.requirements r
     JOIN public.acceptance_criteria a ON a.requirement_id = r.id AND a.requirement_version = r.current_version
     WHERE r.app_id = $1 AND r.status <> 'deprecated'
     ORDER BY r.code LIMIT 40`,
    [appId],
  );
  const pulls: ReviewPull[] = [];
  try {
    const linked = await binding(appId);
    const open = (await linked.repo.listPullRequests()).filter((item) => item.state === "open").slice(0, 3);
    for (const item of open) {
      const diff = (await linked.repo.getPullRequestDiff(item.number)).slice(0, 8000);
      pulls.push({ number: item.number, title: item.title, diff });
    }
  } catch {
    // 没有绑定仓库或远端暂时不可用时，评审仍留下对照材料。
  }
  return {
    constitution: String(constitution[0]?.["content"] ?? ""),
    criteria: criteria.map((row) => `${row["code"]} ${row["ac"]} ${row["text"]}`).join("\n"),
    pulls,
  };
}

export async function commentOnPull(appId: string, number: number, body: string): Promise<void> {
  const linked = await binding(appId);
  await linked.repo.commentPullRequest(number, body.slice(0, 4000));
}

export interface FlowMetrics {
  cycle_hours: number | null;
  cycle_samples: number;
  stages: { stage: string; hours: number; samples: number }[];
  requirements: number;
  covered_requirements: number;
  approved: number;
  decided: number;
}

function hoursOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

export async function flowMetrics(appId: string): Promise<FlowMetrics> {
  const runs = await serviceQuery()(
    `SELECT EXTRACT(EPOCH FROM (finished_at - started_at)) / 3600 AS hours
     FROM public.workflow_runs
     WHERE app_id = $1 AND status = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
    [appId],
  );
  const stages = await serviceQuery()(
    `SELECT stage, AVG(EXTRACT(EPOCH FROM (finished_at - COALESCE(started_at, created_at))) / 3600) AS hours, COUNT(*)::int AS n
     FROM public.step_runs
     WHERE app_id = $1 AND status = 'succeeded' AND finished_at IS NOT NULL
     GROUP BY stage ORDER BY stage`,
    [appId],
  );
  const reqs = await serviceQuery()(`SELECT COUNT(*)::int AS n FROM public.requirements WHERE app_id = $1 AND status <> 'deprecated'`, [appId]);
  const covered = await serviceQuery()(`SELECT COUNT(DISTINCT requirement_id)::int AS n FROM public.test_cases WHERE app_id = $1`, [appId]);
  const decisions = await serviceQuery()(
    `SELECT decision, COUNT(*)::int AS n FROM public.step_runs WHERE app_id = $1 AND decision IS NOT NULL GROUP BY decision`,
    [appId],
  );
  const approved = decisions.filter((row) => row["decision"] === "approve").reduce((sum, row) => sum + Number(row["n"] ?? 0), 0);
  const decided = decisions.reduce((sum, row) => sum + Number(row["n"] ?? 0), 0);
  const samples = runs.map((row) => hoursOf(row["hours"])).filter((hours) => hours >= 0);
  const cycle = samples.length ? Math.round((samples.reduce((sum, hours) => sum + hours, 0) / samples.length) * 10) / 10 : null;
  return {
    cycle_hours: cycle,
    cycle_samples: samples.length,
    stages: stages.map((row) => ({ stage: String(row["stage"]), hours: hoursOf(row["hours"]), samples: Number(row["n"] ?? 0) })),
    requirements: Number(reqs[0]?.["n"] ?? 0),
    covered_requirements: Number(covered[0]?.["n"] ?? 0),
    approved,
    decided,
  };
}
