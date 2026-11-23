import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, Blocks, FileCheck2, GitPullRequest, Layers, ShieldCheck, Terminal } from "lucide-react";
import { signIn, signUp } from "@/data/auth";
import { KyndrylLogo, ThemeSwitcher } from "@/components/sdf/KyndrylBrand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "登录 · SDF 智能应用工厂" },
      { name: "description", content: "登录或注册 Kyndryl Enterprise SDF 智能应用工厂。" },
      { property: "og:title", content: "登录 · SDF 智能应用工厂" },
      { property: "og:description", content: "登录或注册 Kyndryl Enterprise SDF 智能应用工厂。" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

const MODULES = [
  {
    icon: FileCheck2,
    title: "需求与规格治理",
    desc: "从访谈纪要抽取用户故事与验收标准，自动排查冲突、重复与含糊表述。",
  },
  {
    icon: Layers,
    title: "架构与可交互原型",
    desc: "统一生成工程规范、关系型 DDL、OpenAPI 接口契约与可点击业务原型。",
  },
  {
    icon: GitPullRequest,
    title: "开发交接与代码评审",
    desc: "按任务打包开发上下文推送代码仓，拉取合并请求差异自动写回评审意见。",
  },
  {
    icon: ShieldCheck,
    title: "交付检查与持续演进",
    desc: "汇总测试与安全扫描结果核验交付条件，衔接业务门户反馈、确认与验收。",
  },
  {
    icon: Blocks,
    title: "33 块可插拔积木",
    desc: "按应用体量选择轻量、标准、完整三档工作流，支持 YAML 定制与独立启停。",
  },
  {
    icon: Terminal,
    title: "CLI 与 MCP 双入口",
    desc: "支持在 CI 流水线与编码工具中直接读取任务上下文、上传报告与执行检查。",
  },
] as const;

function AuthPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "in") {
        await signIn(email, password);
        nav({ to: "/apps" });
      } else {
        const r = await signUp(email, password, name);
        if (r.needsConfirm) setMsg({ kind: "ok", text: "注册成功，请到邮箱点击确认链接后再登录。" });
        else nav({ to: "/apps" });
      }
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "操作失败" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <header className="border-b border-border bg-panel">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3.5">
          <div className="flex items-center gap-3">
            <KyndrylLogo className="h-[22px] w-auto" />
            <span className="h-4 w-px bg-border" aria-hidden />
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold tracking-tight text-foreground">Enterprise SDF Platform</span>
              <span className="hidden text-xs text-muted-foreground sm:inline">智能应用工厂</span>
            </div>
          </div>
          <ThemeSwitcher compact />
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-7xl flex-1 items-center gap-10 px-6 py-10 lg:grid-cols-[1.25fr_0.85fr] lg:py-14">
        <section className="blueprint-grid rounded-md border border-border bg-panel/60 p-6 sm:p-10">
          <p className="stencil text-[11px] font-medium text-primary">AGENTIC APPLICATION FACTORY</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-bold leading-tight tracking-tight text-foreground sm:text-4xl">
            把企业软件交付纳入统一治理，从业务意图直达生产发布。
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            十位专业角色智能体协同起草需求规格、数据与接口契约、可交互原型、测试用例与设计文档；交付负责人与业务代表在关键确认点拍板决策，全链路留痕可追溯。
          </p>
          <div className="hazard-stripe mt-7 h-1.5 max-w-xs opacity-60" aria-hidden />

          <div className="mt-8">
            <h2 className="stencil text-[11px] text-muted-foreground">FACTORY CAPABILITIES</h2>
            <div className="mt-3 grid gap-px overflow-hidden rounded-sm border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
              {MODULES.map((m) => (
                <div key={m.title} className="bg-panel p-4 transition-colors hover:bg-muted/40">
                  <m.icon className="size-4 text-primary" aria-hidden />
                  <h3 className="mt-2.5 text-xs font-semibold text-foreground">{m.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{m.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-md">
          <div className="panel-surface rounded-md p-6 sm:p-8">
            <div className="mb-5">
              <p className="stencil text-[10px] font-medium text-primary">WORKBENCH ACCESS</p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
                {mode === "in" ? "登录工作台" : "注册工作台账号"}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                使用企业邮箱与口令进入受治理的应用交付空间
              </p>
            </div>

            <Tabs
              value={mode}
              onValueChange={(v) => {
                setMode(v as "in" | "up");
                setMsg(null);
              }}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="in">登录</TabsTrigger>
                <TabsTrigger value="up">注册</TabsTrigger>
              </TabsList>
            </Tabs>

            <form onSubmit={submit} className="mt-5 space-y-4">
              {mode === "up" && (
                <div className="space-y-1.5">
                  <Label htmlFor="name">姓名</Label>
                  <Input
                    id="name"
                    required
                    maxLength={50}
                    placeholder="例如：张晓亮"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="email">邮箱</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">密码</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete={mode === "in" ? "current-password" : "new-password"}
                  placeholder="至少 8 位字符"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {msg && (
                <div
                  role="status"
                  className={
                    msg.kind === "err"
                      ? "rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                      : "rounded-sm border border-success/30 bg-success/10 px-3 py-2 text-xs text-success"
                  }
                >
                  {msg.text}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={busy}>
                <span>{busy ? "请稍候…" : mode === "in" ? "登录" : "注册"}</span>
                {!busy && <ArrowRight className="size-4" />}
              </Button>
            </form>
          </div>
        </section>
      </div>

      <footer className="border-t border-border bg-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-6 py-4 text-xs text-muted-foreground">
          <span>Kyndryl Enterprise SDF Platform · 智能应用工厂</span>
          <span className="stencil text-[10px]">GOVERNED SDLC WORKBENCH</span>
        </div>
      </footer>
    </div>
  );
}
