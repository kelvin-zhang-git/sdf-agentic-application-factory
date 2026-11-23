import { diffLines } from "diff";
export function artifactDiff(previous: string, current: string) {
  return diffLines(previous, current).map((part) => ({ text: part.value, kind: part.added ? "added" : part.removed ? "removed" : "same" }));
}
export function artifactFilename(title: string, format: string, version: number) {
  return `${title.replace(/[^\p{L}\p{N}_-]/gu, "_")}-v${version}.${format === "markdown" ? "md" : format === "mermaid" ? "mmd" : format}`;
}