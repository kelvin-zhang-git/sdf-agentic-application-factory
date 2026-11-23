/** 阶段 3 的六条自动规则。开关存在 hooks 表，默认开启。 */
export const HOOK_EVENTS = [
  "feedback.created",
  "change_request.approved",
  "report.imported",
  "merge_request.collected",
  "uat.item_failed",
  "release.published",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
