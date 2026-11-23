export interface BaselineItem { code: string; title: string; version: number }

export function diffBaselines(before: BaselineItem[], after: BaselineItem[]): { added: BaselineItem[]; removed: BaselineItem[]; changed: BaselineItem[] } {
  const old = new Map(before.map((item) => [item.code, item]));
  const next = new Map(after.map((item) => [item.code, item]));
  const added = after.filter((item) => !old.has(item.code));
  const removed = before.filter((item) => !next.has(item.code));
  const changed = after.filter((item) => {
    const previous = old.get(item.code);
    return previous && (previous.version !== item.version || previous.title !== item.title);
  });
  return { added, removed, changed };
}

export function explainBaseline(diff: { added: BaselineItem[]; removed: BaselineItem[]; changed: BaselineItem[] }, origins: string[]): string {
  const parts = [
    diff.added.length ? `新增 ${diff.added.map((item) => item.code).join("、")}` : "",
    diff.removed.length ? `去掉 ${diff.removed.map((item) => item.code).join("、")}` : "",
    diff.changed.length ? `调整 ${diff.changed.map((item) => item.code).join("、")}` : "",
  ].filter(Boolean);
  const change = parts.length ? parts.join("；") + "。" : "这两版需求条目没有变化。";
  const from = origins.length ? `对应的变更和决策：${origins.join("、")}。` : "";
  return `${change}${from}`;
}
