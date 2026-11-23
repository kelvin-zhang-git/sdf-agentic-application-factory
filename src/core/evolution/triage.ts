export type FeedbackCategory = "bug" | "new_feature" | "change" | "question" | "wontfix";

/** 模型没有给出合法分类时，用词面判断，保证反馈不会停在未分类。 */
export function keywordTriage(text: string, requirementCodes: string[]): { category: FeedbackCategory; requirement_code: string | null; priority: string; reason: string } {
  const mentioned = text.match(/REQ-\d+/)?.[0] ?? null;
  const requirement_code = mentioned && requirementCodes.includes(mentioned) ? mentioned : requirementCodes[0] ?? null;
  if (/不要|不做|不用改|取消/.test(text)) return { category: "wontfix", requirement_code, priority: "could", reason: "反馈里写了先不做。" };
  if (/什么意思|问一下|是否|吗？|\?|？/.test(text) && !/改|增加|不能/.test(text)) return { category: "question", requirement_code, priority: "should", reason: "这是一句问询。" };
  if (/不能|失败|报错|错了|坏了|无法/.test(text)) return { category: "bug", requirement_code, priority: "must", reason: "描述的是现有功能没有按预期工作。" };
  if (/改成|调整|变更|希望|增加|加上/.test(text)) return { category: "change", requirement_code, priority: "should", reason: "这是在现有功能上的调整。" };
  return { category: "new_feature", requirement_code, priority: "should", reason: "更像一项新的使用需求。" };
}
