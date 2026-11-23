/** 路由里实际用到的一层关联。键是「当前表.关联名」。 */
export interface Relation {
  to: string;
  card: "one" | "many";
  local: string;
  foreign: string;
}

export const RELATIONS: Record<string, Relation> = {
  "workflow_runs.workflows": { to: "workflows", card: "one", local: "workflow_id", foreign: "id" },
  "workflow_runs.step_runs": { to: "step_runs", card: "many", local: "id", foreign: "run_id" },
  "workflow_runs.apps": { to: "apps", card: "one", local: "app_id", foreign: "id" },
  "step_runs.workflow_runs": { to: "workflow_runs", card: "one", local: "run_id", foreign: "id" },
  "step_runs.apps": { to: "apps", card: "one", local: "app_id", foreign: "id" },
  "sources.source_segments": { to: "source_segments", card: "many", local: "id", foreign: "source_id" },
  "source_segments.sources": { to: "sources", card: "one", local: "source_id", foreign: "id" },
  "requirements.acceptance_criteria": { to: "acceptance_criteria", card: "many", local: "id", foreign: "requirement_id" },
  "clarification_questions.contacts": { to: "contacts", card: "one", local: "contact_id", foreign: "id" },
  "apps.app_members": { to: "app_members", card: "many", local: "id", foreign: "app_id" },
  "app_members.profiles": { to: "profiles", card: "one", local: "user_id", foreign: "id" },
  "app_contacts.contacts": { to: "contacts", card: "one", local: "contact_id", foreign: "id" },
};
