// 阶段 3 的反馈、变更、验收和发布。业务说明里不写表名和接口名。
import { AppError } from "@/core/errors";
import { diffBaselines, explainBaseline, type BaselineItem } from "@/core/evolution/baseline";
import { keywordTriage, type FeedbackCategory } from "@/core/evolution/triage";
import type { HookEvent } from "@/core/hooks";
import { createServiceDb, serviceQuery } from "./pg-client";

async function enabled(event: HookEvent): Promise<boolean> {
  const rows = await serviceQuery()("SELECT enabled FROM public.hooks WHERE event_key = $1", [event]);
  return rows[0]?.["enabled"] !== false;
}

export async function notifyUsers(appId: string, roles: string[], title: string, body: string): Promise<void> {
  if (!roles.length) return;
  await serviceQuery()(
    `INSERT INTO public.notifications(app_id, user_id, title, body)
     SELECT $1, user_id, $2, $3 FROM public.app_members WHERE app_id = $1 AND role::text = ANY($4::text[])`,
    [appId, title, body, roles],
  );
}

export async function triageFeedback(appId: string, feedbackId: string): Promise<void> {
  if (!(await enabled("feedback.created"))) return;
  const rows = await serviceQuery()("SELECT title, body, created_by FROM public.feedback_items WHERE id = $1", [feedbackId]);
  const item = rows[0];
  if (!item) return;
  const reqs = await serviceQuery()("SELECT code FROM public.requirements WHERE app_id = $1 ORDER BY code", [appId]);
  const codes = reqs.map((row) => String(row["code"]));
  const text = `${item["title"]}\n${item["body"]}`;
  const lexical = keywordTriage(text, codes);
  let result = lexical;
  const open = await serviceQuery()("SELECT code, title FROM public.feedback_items WHERE app_id = $1 AND id <> $2 AND status NOT IN ('released','wontfix') ORDER BY created_at DESC LIMIT 20", [appId, feedbackId]);
  const duplicate = open.find((row) => text.includes(String(row["title"]).slice(0, 8)));
  try {
    const { gatewayFor } = await import("./engine-store");
    const { extractJson } = await import("@/core/model-gateway");
    const app = await serviceQuery()("SELECT classification, redact_before_llm, redact_terms FROM public.apps WHERE id = $1", [appId]);
    const gateway = await gatewayFor(
      {
        id: appId,
        classification: String(app[0]?.["classification"] ?? "internal") as "internal",
        redact_before_llm: Boolean(app[0]?.["redact_before_llm"]),
        redact_terms: Array.isArray(app[0]?.["redact_terms"]) ? (app[0]["redact_terms"] as string[]) : [],
      },
      "feedback-triage",
      String(item["created_by"] ?? ""),
      undefined,
      "requirement_analyst",
    );
    const reply = await gateway.complete("fast", [
      { role: "system", content: "你是业务分析师。只输出 JSON：{\"category\":\"bug|new_feature|change|question|wontfix\",\"requirement_code\":\"REQ-0001 或 null\",\"priority\":\"must|should|could\",\"reason\":\"一句中文\"}。不要编造不存在的需求编号。" },
      { role: "user", content: `反馈：${text.slice(0, 2000)}\n已有需求：${codes.slice(0, 40).join("、")}` },
    ], 400);
    const parsed = extractJson(reply.content) as { category?: string; requirement_code?: string; priority?: string; reason?: string };
    const category = parsed.category;
    if (category === "bug" || category === "new_feature" || category === "change" || category === "question" || category === "wontfix") {
      // 词面已经明确是调整、缺陷或不做时，不用模型的「新功能」把它盖掉。
      const locked = lexical.category === "change" || lexical.category === "bug" || lexical.category === "wontfix";
      result = {
        category: locked ? lexical.category : category,
        requirement_code: parsed.requirement_code && codes.includes(parsed.requirement_code) ? parsed.requirement_code : result.requirement_code,
        priority: parsed.priority || result.priority,
        reason: parsed.reason || result.reason,
      };
    }
  } catch {
    // 模型不可用时保留词面分类，反馈仍然会进入待处理。
  }
  await serviceQuery()(
    `UPDATE public.feedback_items SET category = $2, requirement_code = $3, suggested_priority = $4, triage_reason = $5, duplicate_code = $6, status = 'triaged' WHERE id = $1`,
    [feedbackId, result.category satisfies FeedbackCategory, result.requirement_code, result.priority, result.reason, duplicate ? String(duplicate["code"]) : null],
  );
}

export async function saveChangeSummary(appId: string, changeId: string, business: string, technical: string): Promise<void> {
  await serviceQuery()("UPDATE public.change_requests SET business_summary = $2, status = 'pending_confirm' WHERE id = $1", [changeId, business]);
  const db = createServiceDb();
  await db.rpc("sdf_write_artifact", {
    _app: appId,
    _a: { type: "business_summary", key: changeId, title: "这次改什么", content: business, agent_role: "ba" },
    _step: null, _actor: null, _source: "agent",
  });
  await db.rpc("sdf_write_artifact", {
    _app: appId,
    _a: { type: "change_plan", key: changeId, title: "技术变更方案", content: technical, agent_role: "ba" },
    _step: null, _actor: null, _source: "agent",
  });
  if (await enabled("change_request.approved")) {
    // 确认完成前只提醒业务方去看说明。通过之后再提醒负责人启动后续工作。
  }
  await notifyUsers(appId, ["business"], "有一项改动等你确认", business.slice(0, 180));
}

export async function markChangeApproved(appId: string, changeId: string, userId: string, summary: string): Promise<void> {
  await serviceQuery()("UPDATE public.change_requests SET status = 'approved' WHERE id = $1 AND app_id = $2", [changeId, appId]);
  const code = await serviceQuery()("SELECT public.next_code($1, 'DEC') AS code", [appId]);
  await serviceQuery()(
    "INSERT INTO public.decisions(app_id, code, title, body, made_by) VALUES ($1,$2,$3,$4,$5)",
    [appId, code[0]?.["code"], "同意这次改动", summary.slice(0, 1000), userId],
  );
  if (await enabled("change_request.approved")) await notifyUsers(appId, ["lead"], "变更已确认", "可以启动功能增强。");
}

export async function createUat(appId: string, changeId: string | null, iterationId: string | null): Promise<number> {
  const codes = changeId
    ? ((await serviceQuery()("SELECT requirement_codes FROM public.change_requests WHERE id = $1", [changeId]))[0]?.["requirement_codes"] as string[] | undefined) ?? []
    : [];
  const criteria = await serviceQuery()(
    `SELECT a.code, a.text, r.title FROM public.acceptance_criteria a
     JOIN public.requirements r ON r.id = a.requirement_id AND r.current_version = a.requirement_version
     WHERE a.app_id = $1 AND (cardinality($2::text[]) = 0 OR r.code = ANY($2::text[]))
     ORDER BY a.code LIMIT 8`,
    [appId, codes],
  );
  const linked = await serviceQuery()(
    `SELECT c.linked_profile_id FROM public.app_contacts ac JOIN public.contacts c ON c.id = ac.contact_id
     WHERE ac.app_id = $1 AND c.linked_profile_id IS NOT NULL ORDER BY (c.name = '吴姐') DESC LIMIT 1`,
    [appId],
  );
  const session = await serviceQuery()(
    "INSERT INTO public.uat_sessions(app_id, iteration_id, change_request_id) VALUES ($1,$2,$3) RETURNING id",
    [appId, iterationId, changeId],
  );
  const assignee = linked[0]?.["linked_profile_id"] ?? null;
  for (const item of criteria) {
    await serviceQuery()(
      `INSERT INTO public.uat_items(session_id, app_id, ac_code, title, steps, expected, assignee_profile_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [session[0]?.["id"], appId, item["code"], item["title"], `按平时的操作走一遍：${item["text"]}`, String(item["text"]), assignee],
    );
  }
  if (assignee) await serviceQuery()(
    "INSERT INTO public.notifications(app_id, user_id, title, body) VALUES ($1,$2,'有验收要你看一下','打开业务门户的验收任务，按页面上的步骤点一遍。')",
    [appId, assignee],
  );
  return criteria.length;
}

export async function publishRelease(appId: string, version: string, userId: string | null, notes: { business: string; technical: string }, iterationId: string | null): Promise<void> {
  if (await enabled("release.published")) {
    await serviceQuery()(
      `INSERT INTO public.baselines(app_id, version, snapshot)
       SELECT $1, $2, COALESCE(jsonb_agg(jsonb_build_object('code', code, 'title', title, 'version', current_version) ORDER BY code), '[]'::jsonb)
       FROM public.requirements WHERE app_id = $1 AND status <> 'deprecated'
       ON CONFLICT (app_id, version) DO UPDATE SET snapshot = EXCLUDED.snapshot`,
      [appId, version],
    );
    await serviceQuery()(
      `UPDATE public.feedback_items SET status = 'released', released_in = $2
       WHERE app_id = $1 AND status = 'accepted'`,
      [appId, version],
    );
    const authors = await serviceQuery()("SELECT DISTINCT created_by FROM public.feedback_items WHERE app_id = $1 AND released_in = $2 AND created_by IS NOT NULL", [appId, version]);
    for (const author of authors) {
      await serviceQuery()(
        "INSERT INTO public.notifications(app_id, user_id, title, body) VALUES ($1,$2,'你提的意见已经上线',$3)",
        [appId, author["created_by"], version],
      );
    }
  }
  await serviceQuery()(
    `INSERT INTO public.releases(app_id, iteration_id, version, notes_business, notes_technical, published_by)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (app_id, version) DO UPDATE SET notes_business = EXCLUDED.notes_business, notes_technical = EXCLUDED.notes_technical`,
    [appId, iterationId, version, notes.business, notes.technical, userId],
  );
  await serviceQuery()("UPDATE public.apps SET current_version = $2 WHERE id = $1", [appId, version]);
  if (iterationId) await serviceQuery()("UPDATE public.iterations SET status = 'released' WHERE id = $1", [iterationId]);
  const db = createServiceDb();
  await db.rpc("sdf_write_artifact", {
    _app: appId, _a: { type: "notes_business", key: version, title: `${version} 这一版改了什么`, content: notes.business, agent_role: "lead" },
    _step: null, _actor: userId, _source: "agent",
  });
}

export async function compareBaselines(appId: string, from: string, to: string): Promise<{ explanation: string; added: string[]; removed: string[]; changed: string[] }> {
  const rows = await serviceQuery()("SELECT version, snapshot FROM public.baselines WHERE app_id = $1 AND version = ANY($2::text[])", [appId, [from, to]]);
  const read = (version: string) => (rows.find((row) => row["version"] === version)?.["snapshot"] as BaselineItem[] | undefined) ?? [];
  const diff = diffBaselines(read(from), read(to));
  const origins = await serviceQuery()(
    `SELECT code FROM public.change_requests WHERE app_id = $1 AND status IN ('approved','released')
     UNION ALL SELECT code FROM public.decisions WHERE app_id = $1 ORDER BY 1 DESC LIMIT 8`,
    [appId],
  );
  return {
    explanation: explainBaseline(diff, origins.map((row) => String(row["code"]))),
    added: diff.added.map((item) => item.code),
    removed: diff.removed.map((item) => item.code),
    changed: diff.changed.map((item) => item.code),
  };
}

export async function meetingAgenda(appId: string): Promise<string> {
  const [feedback, changes, questions] = await Promise.all([
    serviceQuery()("SELECT code, title FROM public.feedback_items WHERE app_id = $1 AND status IN ('open','triaged') ORDER BY code", [appId]),
    serviceQuery()("SELECT code, title FROM public.change_requests WHERE app_id = $1 AND status = 'pending_confirm' ORDER BY code", [appId]),
    serviceQuery()("SELECT code, question FROM public.clarification_questions WHERE app_id = $1 AND status = 'open' ORDER BY code LIMIT 20", [appId]),
  ]);
  const line = (rows: Record<string, unknown>[], field: string) => rows.map((row) => `- ${row["code"]} ${row[field] ?? ""}`).join("\n") || "- 无";
  return `# 业务沟通会议程\n\n## 还没处理的反馈\n${line(feedback, "title")}\n\n## 等业务确认的改动\n${line(changes, "title")}\n\n## 还没回答的问题\n${line(questions, "question")}\n`;
}

export async function loadChange(id: string): Promise<{ id: string; code: string; title: string; business_summary: string; requirement_codes: string[]; iteration_id: string | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await serviceQuery()("SELECT id, code, title, business_summary, requirement_codes, iteration_id FROM public.change_requests WHERE id = $1", [id]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row["id"]), code: String(row["code"]), title: String(row["title"]),
    business_summary: String(row["business_summary"] ?? ""),
    requirement_codes: (row["requirement_codes"] as string[]) ?? [],
    iteration_id: row["iteration_id"] ? String(row["iteration_id"]) : null,
  };
}

export function plainBusinessSummary(title: string, codes: string[]): { business: string; technical: string } {
  const list = codes.length ? codes.join("、") : "现有功能";
  return {
    business: `这次改的是「${title}」。改完之后，相关页面会按新的说法展示，原来已经在用的其他功能保持不动。`,
    technical: `变更「${title}」影响需求 ${list}。需要同步调整对应的数据、接口和验收用例。`,
  };
}

export async function requireChange(id: string): Promise<NonNullable<Awaited<ReturnType<typeof loadChange>>>> {
  const row = await loadChange(id);
  if (!row) throw new AppError("NOT_FOUND", "变更请求不存在");
  return row;
}
