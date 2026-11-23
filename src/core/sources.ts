// Source file checks and text segmentation (B01 stages 1–4). Pure: parsing of binary formats is injected.
import { unzipSync, strFromU8 } from "fflate";
import { AppError } from "./errors";

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_PASTE_CHARS = 200_000;
export const MAX_SEGMENTS = 2000;
const TYPES: Record<string, string[]> = {
  txt: ["text/plain"], md: ["text/markdown", "text/x-markdown", "text/plain"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], pdf: ["application/pdf"],
};
export function checkSourceFile(name: string, mime: string, size: number): "txt" | "md" | "docx" | "pdf" {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (!TYPES[ext]) throw new AppError("VALIDATION", "只支持 txt、md、docx、pdf 文件");
  if (size === 0) throw new AppError("VALIDATION", "文件是空的");
  if (size > MAX_SOURCE_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "文件超过 10 MB 上限");
  const m = mime.split(";")[0]!.trim();
  if (m && m !== "application/octet-stream" && !TYPES[ext]!.includes(m)) throw new AppError("VALIDATION", "文件类型与扩展名不一致");
  return ext as "txt" | "md" | "docx" | "pdf";
}
export function docxText(bytes: Uint8Array): string {
  let xml: string;
  try { const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" }); xml = strFromU8(files["word/document.xml"]!); }
  catch { throw new AppError("VALIDATION", "无法读取 docx 文件内容"); }
  return xml.split(/<\/w:p>/).map((p) => Array.from(p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g), (m) => m[1]).join(""))
    .map((t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")).join("\n");
}
export function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { throw new AppError("VALIDATION", "文本文件不是 UTF-8 编码"); }
}
const SPEAKER = /^([\p{L}\p{N}·._ -]{1,20})[:：]\s*(.+)$/u;
const CLAUSE = /^(\d+(?:\.\d+){1,4}|[A-Z]{1,6}-\d+(?:\.\d+)*)[\s、]+(.+)$/;
export function segmentText(text: string): { speaker: string | null; text: string; clause?: string }[] {
  const out: { speaker: string | null; text: string; clause?: string }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split(/\n+/)) {
    const line = raw.trim().replace(/^#+\s*/, "");
    if (!line) continue;
    const clause = CLAUSE.exec(line);
    const m = clause ? null : SPEAKER.exec(line);
    const body = clause ? clause[2]!.trim() : m ? m[2]!.trim() : line;
    const speaker = m ? m[1]!.trim() : null;
    for (let i = 0; i < body.length; i += 2000) {
      const piece: { speaker: string | null; text: string; clause?: string } = { speaker, text: body.slice(i, i + 2000) };
      if (clause && i === 0) piece.clause = clause[1]!;
      out.push(piece);
    }
  }
  if (!out.length) throw new AppError("VALIDATION", "没有解析出任何文字内容");
  if (out.length > MAX_SEGMENTS) throw new AppError("VALIDATION", `段落超过 ${MAX_SEGMENTS} 段，请拆分后上传`);
  return out;
}
