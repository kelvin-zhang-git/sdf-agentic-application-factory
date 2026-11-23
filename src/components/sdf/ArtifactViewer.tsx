import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download } from "lucide-react";
import { artifactsQuery } from "@/data/examples";
import { artifactDiff, artifactFilename } from "@/core/artifacts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorBox } from "./common";
function Diagram({ content }: { content: string }) {
  const [svg, setSvg] = useState(""); const [failed, setFailed] = useState(false);
  useEffect(() => { let cancelled = false; setSvg(""); setFailed(false);
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", suppressErrorRendering: true });
      const result = await mermaid.render(`diagram-${crypto.randomUUID()}`, content);
      if (!cancelled) setSvg(result.svg);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [content]);
  return failed ? <p className="text-destructive">图表无法显示，请查看原文。</p> : <iframe title="制品图表" sandbox="" className="h-96 w-full border-0 bg-background" srcDoc={`<!doctype html><html><body>${svg}</body></html>`} />;
}
export function ArtifactViewer({ appId }: { appId: string }) {
  const q = useQuery(artifactsQuery(appId)); const [title, setTitle] = useState(""); const [version, setVersion] = useState("");
  const items = q.data ?? []; const titles = [...new Set(items.map((item) => item.title))];
  const chosenTitle = titles.includes(title) ? title : titles[0] ?? "";
  const versions = items.filter((item) => item.title === chosenTitle).sort((a, b) => b.version - a.version);
  const current = versions.find((item) => String(item.version) === version) ?? versions[0];
  const previous = versions.find((item) => current && item.version < current.version);
  return <section className="min-w-0 space-y-4"><h3 className="font-semibold">示例制品</h3><ErrorBox error={q.error} />
    {q.isPending && <p>加载中…</p>}{q.data && !items.length && <p className="text-sm text-muted-foreground">暂无示例制品</p>}
    {current && <><div className="flex flex-wrap items-center gap-3"><Select value={chosenTitle} onValueChange={(v) => { setTitle(v); setVersion(""); }}><SelectTrigger aria-label="制品" className="w-full sm:w-64"><SelectValue /></SelectTrigger><SelectContent>{titles.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select><Select value={String(current.version)} onValueChange={setVersion}><SelectTrigger aria-label="制品版本" className="w-28"><SelectValue /></SelectTrigger><SelectContent>{versions.map((v) => <SelectItem key={v.id} value={String(v.version)}>v{v.version}</SelectItem>)}</SelectContent></Select><Badge variant="outline">示例数据</Badge><Button variant="outline" size="icon" aria-label="下载制品" title="下载制品" onClick={() => {
      const url = URL.createObjectURL(new Blob([current.content], { type: "text/plain;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = artifactFilename(current.title, current.format, current.version); a.click(); URL.revokeObjectURL(url);
    }}><Download className="size-4" /></Button></div>
    <Tabs key={current.id} defaultValue="preview"><TabsList><TabsTrigger value="preview">预览</TabsTrigger><TabsTrigger value="source">原文</TabsTrigger><TabsTrigger value="diff" disabled={!previous}>版本差异</TabsTrigger></TabsList>
      <TabsContent value="preview" className="min-w-0 overflow-auto border p-4">{current.format === "markdown" ? <div className="space-y-3 break-words text-sm [&_h1]:text-xl [&_h2]:text-lg [&_li]:ml-5 [&_li]:list-disc [&_table]:w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{current.content}</ReactMarkdown></div> : current.format === "mermaid" ? <Diagram content={current.content} /> : <pre className="overflow-x-auto font-mono text-xs">{current.format === "json" ? (() => { try { return JSON.stringify(JSON.parse(current.content), null, 2); } catch { return current.content; } })() : current.content}</pre>}</TabsContent>
      <TabsContent value="source"><pre className="overflow-x-auto border p-4 font-mono text-xs">{current.content}</pre></TabsContent>
      <TabsContent value="diff"><pre className="overflow-x-auto border p-4 font-mono text-xs">{previous && artifactDiff(previous.content, current.content).map((part, i) => <span key={i} className={part.kind === "added" ? "bg-success/10 text-success" : part.kind === "removed" ? "bg-destructive/10 text-destructive" : "text-muted-foreground"}>{part.text.split(/(?<=\n)/).map((line) => `${part.kind === "added" ? "+ " : part.kind === "removed" ? "- " : "  "}${line}`).join("")}</span>)}</pre></TabsContent>
    </Tabs></>}
  </section>;
}