export type MatchBy = "body_trailer" | "title_prefix" | "branch_name" | "manual";

/** 认领顺序：正文尾标，标题前缀，分支名。对不上就留给人工绑定。 */
export function matchTask(input: { title: string; body: string; branch: string }, codes: string[]): { code: string; matched_by: MatchBy } | null {
  const known = new Set(codes);
  const body = /SDF-Task:\s*(T-\d+)/.exec(input.body);
  if (body?.[1] && known.has(body[1])) return { code: body[1], matched_by: "body_trailer" };
  const title = /\[(T-\d+)\]/.exec(input.title);
  if (title?.[1] && known.has(title[1])) return { code: title[1], matched_by: "title_prefix" };
  const branch = /^sdf\/(T-\d+)-/.exec(input.branch);
  if (branch?.[1] && known.has(branch[1])) return { code: branch[1], matched_by: "branch_name" };
  return null;
}
