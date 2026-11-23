// MCP 的数据访问。服务角色绕过行级权限，所以这里按成员和平台管理员自行过滤。
import { randomUUID } from "node:crypto";
import { outOfScope } from "@/core/connectors/paths";
import type { McpContext, McpHit, McpRequirement, McpScope, McpStore, McpTask } from "@/core/mcp/protocol";
import { serviceQuery } from "./pg-client";

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function jsonbLiteral(value: unknown): string {
  const tag = `js${randomUUID().replace(/-/g, "")}`;
  return `$${tag}$${JSON.stringify(value)}$${tag}$::jsonb`;
}

async function visibleApp(userId: string, app: string): Promise<{ id: string; name: string } | null> {
  const key = app.trim();
  if (!key) return null;
  const rows = await serviceQuery()(
    `SELECT a.id::text AS id, a.name
     FROM public.apps a
     WHERE (a.id::text = $2 OR a.name = $2)
       AND (
         EXISTS (SELECT 1 FROM public.app_members m WHERE m.app_id = a.id AND m.user_id = $1::uuid)
         OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = $1::uuid AND r.role = 'admin')
       )
     LIMIT 2`,
    [userId, key],
  );
  if (rows.length !== 1) return null;
  return { id: String(rows[0]?.["id"]), name: String(rows[0]?.["name"]) };
}

async function canWrite(userId: string, appId: string): Promise<boolean> {
  const admin = await serviceQuery()(`SELECT 1 FROM public.user_roles WHERE user_id = $1::uuid AND role = 'admin' LIMIT 1`, [userId]);
  if (admin.length) return true;
  const roles = await serviceQuery()(`SELECT role FROM public.app_members WHERE app_id = $1::uuid AND user_id = $2::uuid`, [appId, userId]);
  return roles.some((row) => String(row["role"]) !== "business");
}

export function mcpStore(): McpStore {
  return {
    async listTasks(userId, app): Promise<McpTask[]> {
      const rows = await serviceQuery()(
        `SELECT a.id::text AS app_id, a.name AS app_name, t.code, t.title, t.status, t.allowed_paths, t.forbidden_paths
         FROM public.tasks t
         JOIN public.apps a ON a.id = t.app_id
         WHERE (
           EXISTS (SELECT 1 FROM public.app_members m WHERE m.app_id = a.id AND m.user_id = $1::uuid)
           OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = $1::uuid AND r.role = 'admin')
         )
           AND ($2 = '' OR a.name = $2 OR a.id::text = $2)
         ORDER BY a.name, t.code
         LIMIT 50`,
        [userId, app ?? ""],
      );
      return rows.map((row) => ({
        app_id: String(row["app_id"]),
        app_name: String(row["app_name"]),
        code: String(row["code"]),
        title: String(row["title"]),
        status: String(row["status"]),
        allowed_paths: (row["allowed_paths"] as string[] | null) ?? [],
        forbidden_paths: (row["forbidden_paths"] as string[] | null) ?? [],
      }));
    },
    async getTask(userId, app, code): Promise<McpContext | null> {
      const found = await visibleApp(userId, app);
      if (!found || !code) return null;
      const rows = await serviceQuery()(
        `SELECT t.code, t.title, t.allowed_paths, t.forbidden_paths, a.content
         FROM public.tasks t
         LEFT JOIN public.artifacts a ON a.id = t.context_artifact_id
         WHERE t.app_id = $1::uuid AND t.code = $2
         LIMIT 1`,
        [found.id, code],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        code: String(row["code"]),
        title: String(row["title"]),
        content: clip(String(row["content"] ?? ""), 12000),
        allowed_paths: (row["allowed_paths"] as string[] | null) ?? [],
        forbidden_paths: (row["forbidden_paths"] as string[] | null) ?? [],
      };
    },
    async getRequirement(userId, app, code): Promise<McpRequirement | null> {
      const found = await visibleApp(userId, app);
      if (!found || !code) return null;
      const rows = await serviceQuery()(
        `SELECT code, title, story, status FROM public.requirements WHERE app_id = $1::uuid AND code = $2 LIMIT 1`,
        [found.id, code],
      );
      const row = rows[0];
      if (!row) return null;
      const criteria = await serviceQuery()(
        `SELECT code, text FROM public.acceptance_criteria WHERE app_id = $1::uuid AND requirement_id = (
           SELECT id FROM public.requirements WHERE app_id = $1::uuid AND code = $2 LIMIT 1
         ) ORDER BY code`,
        [found.id, code],
      );
      return {
        code: String(row["code"]),
        title: String(row["title"]),
        story: clip(String(row["story"] ?? ""), 4000),
        status: String(row["status"]),
        criteria: criteria.map((item) => ({ code: String(item["code"]), text: String(item["text"] ?? "") })),
      };
    },
    async lookupTerm(userId, app, term): Promise<McpHit[]> {
      const found = await visibleApp(userId, app);
      const needle = term.trim();
      if (!found || needle.length < 2) return [];
      const like = `%${needle.replace(/[%_]/g, "")}%`;
      const requirements = await serviceQuery()(
        `SELECT code, title, left(story, 240) AS story FROM public.requirements
         WHERE app_id = $1::uuid AND (title ILIKE $2 OR story ILIKE $2 OR code ILIKE $2)
         ORDER BY code LIMIT 6`,
        [found.id, like],
      );
      const criteria = await serviceQuery()(
        `SELECT code, left(text, 240) AS text FROM public.acceptance_criteria
         WHERE app_id = $1::uuid AND (code ILIKE $2 OR text ILIKE $2)
         ORDER BY code LIMIT 6`,
        [found.id, like],
      );
      const domain = await serviceQuery()(
        `SELECT left(content, 1200) AS content FROM public.artifacts
         WHERE app_id = $1::uuid AND type = 'domain_pack' AND is_latest AND content ILIKE $2
         ORDER BY version DESC LIMIT 1`,
        [found.id, like],
      );
      const hits: McpHit[] = [
        ...requirements.map((row) => ({ kind: "requirement", code: String(row["code"]), excerpt: `${row["title"]} ${row["story"] ?? ""}`.trim() })),
        ...criteria.map((row) => ({ kind: "acceptance", code: String(row["code"]), excerpt: String(row["text"] ?? "") })),
      ];
      if (domain[0]?.["content"]) hits.push({ kind: "domain", code: "domain_pack", excerpt: clip(String(domain[0]["content"]), 500) });
      return hits.slice(0, 8);
    },
    async checkScope(userId, app, code, files): Promise<McpScope | null> {
      const task = await this.getTask(userId, app, code);
      if (!task) return null;
      return { task_code: task.code, outside: outOfScope(files, task.allowed_paths, task.forbidden_paths) };
    },
    async submitClarification(userId, app, question, requirementCode): Promise<{ code: string } | null> {
      const found = await visibleApp(userId, app);
      const text = question.trim();
      if (!found || text.length < 2 || text.length > 2000 || !/^REQ-\d+$/.test(requirementCode)) return null;
      if (!(await canWrite(userId, found.id))) return null;
      const req = await serviceQuery()(
        `SELECT id::text AS id FROM public.requirements WHERE app_id = $1::uuid AND code = $2 LIMIT 1`,
        [found.id, requirementCode],
      );
      const requirementId = req[0]?.["id"];
      if (!requirementId) return null;
      const rows = await serviceQuery()(
        `INSERT INTO public.clarification_questions(code, app_id, stakeholder, question, target_refs)
         VALUES (public.next_code($1::uuid, 'Q'), $1::uuid, '开发', $2, ${jsonbLiteral([{ type: "requirement", id: String(requirementId) }])})
         RETURNING code`,
        [found.id, text],
      );
      const code = rows[0]?.["code"];
      return code ? { code: String(code) } : null;
    },
  };
}
