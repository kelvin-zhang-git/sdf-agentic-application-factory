// 用 Office Open XML 打包 Word。页眉、页脚和样式来自报告模板，正文由调用方填好。
import { strToU8, zipSync } from "fflate";

export interface DocSection {
  heading: string;
  level?: 1 | 2 | 3;
  paragraphs?: string[];
  table?: string[][];
}

export interface CoverFlags {
  app_name: boolean;
  classification: boolean;
  artifact_version: boolean;
  generated_at: boolean;
  step_info: boolean;
  agent_role: boolean;
}

export interface StyleConfig {
  accent?: string;
  font_ascii?: string;
  font_east_asia?: string;
}

/** 封面和页眉页脚。没有 cover 时，按已传入的字段决定显示哪些行。 */
export interface DocMeta {
  templateName: string;
  headerText?: string | undefined;
  footerText?: string | undefined;
  showPageNumbers?: boolean | undefined;
  cover?: CoverFlags | undefined;
  style?: StyleConfig | undefined;
  appName?: string | undefined;
  classification?: string | undefined;
  version?: string | undefined;
  generatedAt?: string | undefined;
  stepInfo?: string | undefined;
  agentRole?: string | undefined;
  docTitle?: string | undefined;
}

export const STANDARD_TEMPLATE_NAME = "标准交付文档";

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** 替换 {{app_name}} 这类占位符。写入 XML 时再做转义。 */
export function renderTemplatePlaceholders(raw: string, ctx: Record<string, string>): string {
  return raw.replace(PLACEHOLDER, (_all, key: string) => ctx[key] ?? "");
}

/** 把制品正文拆成 Word 的标题、段落和表格。 */
export function markdownToSections(markdown: string): DocSection[] {
  const sections: DocSection[] = [];
  let current: DocSection = { heading: "正文", paragraphs: [] };
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const commit = () => {
    if (current.paragraphs?.length || current.table?.length || current.heading !== "正文") sections.push(current);
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      commit();
      const marks = heading[1] ?? "#";
      const level = Math.min(marks.length, 3) as 1 | 2 | 3;
      current = { heading: (heading[2] ?? "").trim() || "正文", level, paragraphs: [] };
      i += 1;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        const raw = (lines[i] ?? "").trim();
        i += 1;
        if (/^\|?\s*:?-{3,}/.test(raw)) continue;
        const cells = raw.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        if (cells.some((c) => c)) rows.push(cells);
      }
      if (rows.length) current.table = [...(current.table ?? []), ...rows];
      continue;
    }
    if (line.trim()) current.paragraphs = [...(current.paragraphs ?? []), line.trim()];
    i += 1;
  }
  commit();
  return sections.length ? sections : [{ heading: "正文", paragraphs: [markdown] }];
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function el(name: string, inner = "", attrs = ""): string {
  return `<${name}${attrs}>${inner}<` + `/${name}>`;
}

function accentOf(style?: StyleConfig): string {
  const raw = (style?.accent ?? "FF462D").replace("#", "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(raw) ? raw : "FF462D";
}

function fontsOf(style?: StyleConfig): { ascii: string; east: string } {
  const ascii = style?.font_ascii === "Arial" ? "Arial" : "Calibri";
  const east = style?.font_east_asia === "DengXian" || style?.font_east_asia === "SimSun" ? style.font_east_asia : "Microsoft YaHei";
  return { ascii, east };
}

function fontsXml(fonts: { ascii: string; east: string }): string {
  return `<w:rFonts w:ascii="${fonts.ascii}" w:hAnsi="${fonts.ascii}" w:eastAsia="${fonts.east}"/>`;
}

function run(text: string, fonts: { ascii: string; east: string }, opts?: { bold?: boolean; size?: number; color?: string }): string {
  const bold = opts?.bold ? "<w:b/>" : "";
  const color = opts?.color ? `<w:color w:val="${opts.color}"/>` : "";
  const size = opts?.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : "";
  const props = el("w:rPr", `${bold}${color}${fontsXml(fonts)}${size}`);
  return el("w:r", `${props}${el("w:t", xml(text), ` xml:space="preserve"`)}`);
}

function paragraph(text: string, fonts: { ascii: string; east: string }, style?: string, opts?: { bold?: boolean; size?: number; color?: string }): string {
  const pStyle = style ? el("w:pPr", `<w:pStyle w:val="${style}"/>`) : "";
  return el("w:p", `${pStyle}${run(text, fonts, opts)}`);
}

function table(rows: string[][], fonts: { ascii: string; east: string }, accent: string): string {
  const border = (edge: string) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="D0D0D0"/>`;
  const body = rows.map((row, i) => {
    const cells = row.map((cell) => {
      const head = i === 0 ? el("w:tcPr", `<w:shd w:val="clear" w:color="auto" w:fill="F7F7F7"/>`) : "";
      const text = el("w:p", run(cell, fonts, i === 0 ? { bold: true, color: accent, size: 21 } : { size: 21 }));
      return el("w:tc", `${head}${text}`);
    }).join("");
    return el("w:tr", cells);
  }).join("");
  const borders = el("w:tblBorders", `${border("top")}${border("left")}${border("bottom")}${border("right")}${border("insideH")}${border("insideV")}`);
  const mar = el("w:tblCellMar", `<w:top w:w="60" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="80" w:type="dxa"/>`);
  const pr = el("w:tblPr", `<w:tblW w:w="5000" w:type="pct"/>${borders}${mar}`);
  return el("w:tbl", `${pr}${body}`);
}

function coverLines(meta: DocMeta): string[] {
  const flags: CoverFlags = meta.cover ?? {
    app_name: Boolean(meta.appName),
    classification: Boolean(meta.classification),
    artifact_version: Boolean(meta.version),
    generated_at: Boolean(meta.generatedAt),
    step_info: Boolean(meta.stepInfo),
    agent_role: Boolean(meta.agentRole),
  };
  const lines = [`模板：${meta.templateName}`];
  const bits = [
    flags.app_name && meta.appName ? `应用：${meta.appName}` : "",
    flags.classification && meta.classification ? `密级：${meta.classification}` : "",
    flags.artifact_version && meta.version ? `版本：${meta.version}` : "",
    flags.generated_at && meta.generatedAt ? `生成时间：${meta.generatedAt}` : "",
    flags.step_info && meta.stepInfo ? `步骤：${meta.stepInfo}` : "",
    flags.agent_role && meta.agentRole ? `智能体：${meta.agentRole}` : "",
  ].filter(Boolean);
  if (bits.length) lines.push(bits.join("　"));
  return lines;
}

function partXml(root: "w:hdr" | "w:ftr", inner: string): string {
  const body = el(root, el("w:p", inner), ` xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function pageFields(fonts: { ascii: string; east: string }): string {
  const one = (instr: string) => el("w:fldSimple", run("1", fonts, { size: 18 }), ` w:instr=" ${instr} "`);
  return `${run("  ", fonts, { size: 18 })}${one("PAGE")}${run(" / ", fonts, { size: 18 })}${one("NUMPAGES")}`;
}

function stylesXml(fonts: { ascii: string; east: string }, accent: string): string {
  const r = fontsXml(fonts);
  const style = (id: string, name: string, size: number, color: string, before: number, after: number, bold: boolean) =>
    el("w:style", `${el("w:name", "", ` w:val="${name}"`)}${el("w:pPr", `<w:spacing w:before="${before}" w:after="${after}"/>`)}${el("w:rPr", `${bold ? "<w:b/>" : ""}${r}<w:sz w:val="${size}"/><w:color w:val="${color}"/>`)}`, ` w:type="paragraph" w:styleId="${id}"`);
  const defaults = el("w:docDefaults", el("w:rPrDefault", el("w:rPr", `${r}<w:sz w:val="21"/>`)));
  const styles = [
    style("Title", "Title", 36, accent, 0, 120, true),
    style("Heading1", "heading 1", 28, accent, 280, 80, true),
    style("Heading2", "heading 2", 24, "222222", 200, 60, true),
    style("Heading3", "heading 3", 22, "222222", 160, 40, true),
    style("Normal", "Normal", 21, "222222", 0, 60, false),
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?>${el("w:styles", `${defaults}${styles}`, ` xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`)}`;
}

export function buildDocx(title: string, sections: DocSection[], meta?: DocMeta): Uint8Array {
  const fonts = fontsOf(meta?.style);
  const accent = accentOf(meta?.style);
  const ctx = {
    app_name: meta?.appName ?? "",
    classification: meta?.classification ?? "",
    doc_title: meta?.docTitle || title,
    version: meta?.version ?? "",
    template_name: meta?.templateName ?? STANDARD_TEMPLATE_NAME,
  };
  const header = renderTemplatePlaceholders(meta?.headerText ?? "{{template_name}}", ctx);
  const footer = renderTemplatePlaceholders(meta?.footerText ?? "本文档套用「{{template_name}}」模板生成。", ctx);
  const showPages = meta?.showPageNumbers !== false;
  const headingStyle = (level?: 1 | 2 | 3) => (level === 3 ? "Heading3" : level === 2 ? "Heading2" : "Heading1");
  const headingSize = (level?: 1 | 2 | 3) => (level === 3 ? 22 : level === 2 ? 24 : 28);
  const bodyInner = [
    paragraph(title, fonts, "Title", { bold: true, size: 36, color: accent }),
    ...(meta ? coverLines(meta).map((line) => paragraph(line, fonts, undefined, { size: 21 })) : []),
    ...sections.flatMap((section) => [
      paragraph(section.heading, fonts, headingStyle(section.level), { bold: true, size: headingSize(section.level), color: section.level && section.level > 1 ? "222222" : accent }),
      ...(section.paragraphs ?? []).map((p) => paragraph(p, fonts, "Normal", { size: 21 })),
      ...(section.table?.length ? [table(section.table, fonts, accent)] : []),
    ]),
  ].join("");
  const sect = el("w:sectPr", `<w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/>`);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${el("w:document", el("w:body", `${bodyInner}${sect}`), ` xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`)}`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>${el("Types", [
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="xml" ContentType="application/xml"/>`,
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
    `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`,
    `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`,
  ].join(""), ` xmlns="http://schemas.openxmlformats.org/package/2006/content-types"`)}`;
  const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
  const pkgRels = `<?xml version="1.0" encoding="UTF-8"?>${el("Relationships", rel("rId1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "word/document.xml"), ` xmlns="http://schemas.openxmlformats.org/package/2006/relationships"`)}`;
  const docRels = `<?xml version="1.0" encoding="UTF-8"?>${el("Relationships", [
    rel("rId1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", "styles.xml"),
    rel("rId2", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header", "header1.xml"),
    rel("rId3", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer", "footer1.xml"),
  ].join(""), ` xmlns="http://schemas.openxmlformats.org/package/2006/relationships"`)}`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(types),
    "_rels/.rels": strToU8(pkgRels),
    "word/_rels/document.xml.rels": strToU8(docRels),
    "word/styles.xml": strToU8(stylesXml(fonts, accent)),
    "word/header1.xml": strToU8(partXml("w:hdr", run(header, fonts, { size: 18 }))),
    "word/footer1.xml": strToU8(partXml("w:ftr", `${run(footer, fonts, { size: 18 })}${showPages ? pageFields(fonts) : ""}`)),
    "word/document.xml": strToU8(documentXml),
  };
  return zipSync(files);
}

export function docxAttachment(bytes: Uint8Array, filename: string): { body: Blob; headers: Record<string, string> } {
  const packed = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(packed).set(bytes);
  const safe = filename.replace(/[\\/:*?"<>|]/g, "-");
  return {
    body: new Blob([packed]),
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="sdf.docx"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    },
  };
}
