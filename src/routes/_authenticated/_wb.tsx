import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Inbox, LayoutGrid, Workflow, Blocks, Bot, Plug, Settings, LogOut, Store, Search, Gauge } from "lucide-react";
import { meQuery } from "@/data/sdf";
import { inboxQuery } from "@/data/runs";
import { useLiveRun } from "@/hooks/use-live-run";
import { signOut } from "@/data/auth";
import { getViewMode, setViewMode } from "@/data/view";
import { ROLE_LABEL } from "@/data/types";
import { Button } from "@/components/ui/button";
import { RouteError } from "@/components/sdf/RouteError";
import { KyndrylLogo, ThemeSwitcher } from "@/components/sdf/KyndrylBrand";
import { openCommandPalette } from "@/components/sdf/CommandPalette";

export const Route = createFileRoute("/_authenticated/_wb")({
  loader: ({ context }) => context.queryClient.ensureQueryData(meQuery()),
  component: WorkbenchLayout,
  errorComponent: RouteError,
});

const NAV = [
  { to: "/dashboard", label: "全局大盘", icon: Gauge, adminOnly: true },
  { to: "/inbox", label: "我的待办", icon: Inbox, adminOnly: false },
  { to: "/apps", label: "应用", icon: LayoutGrid, adminOnly: false },
  { to: "/workflows", label: "工作流", icon: Workflow, adminOnly: false },
  { to: "/blocks", label: "积木", icon: Blocks, adminOnly: false },
  { to: "/agents", label: "智能体", icon: Bot, adminOnly: false },
  { to: "/connectors", label: "连接器", icon: Plug, adminOnly: false },
  { to: "/admin", label: "管理", icon: Settings, adminOnly: true },
] as const;

const INBOX_KEY = ["inbox"] as const;

function WorkbenchLayout() {
  const { data: me } = useSuspenseQuery(meQuery());
  const nav = useNavigate();
  useLiveRun(INBOX_KEY);
  const inbox = useQuery({ ...inboxQuery(), refetchInterval: 60_000, refetchIntervalInBackground: false });
  const inboxBadge = (inbox.data?.items.length ?? 0) + (inbox.data?.notices.length ?? 0) + (inbox.data?.mentions.length ?? 0);
  const badgeText = inboxBadge > 99 ? "99+" : String(inboxBadge);
  useEffect(() => {
    if (me.business_only || getViewMode() === "portal") nav({ to: "/portal" });
  }, [me.business_only, nav]);
  const isAdmin = me.global_roles.includes("admin");
  const visibleNav = NAV.filter((n) => !n.adminOnly || isAdmin);

  return (
    <div className="min-h-[100dvh] bg-background">
      <div className="flex min-h-[100dvh]">
        <aside className="sticky top-0 hidden h-[100dvh] w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
          <div className="border-b border-sidebar-border px-4 py-4">
            <Link to="/apps" className="group block focus-visible:outline-none">
              <div className="flex items-center gap-2.5">
                <KyndrylLogo className="h-[20px] w-auto" />
                <span className="h-3.5 w-px bg-sidebar-border" aria-hidden />
                <span className="stencil text-[10px] font-medium text-muted-foreground">SDF</span>
              </div>
              <p className="mt-1.5 text-xs font-semibold tracking-tight text-foreground group-hover:text-primary transition-colors">
                Enterprise SDF · 智能应用工厂
              </p>
            </Link>
          </div>

          <div className="px-3 pt-3">
            <button
              type="button"
              onClick={openCommandPalette}
              className="flex w-full items-center justify-between rounded-sm border border-sidebar-border bg-background/70 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <span className="flex items-center gap-2">
                <Search className="size-3.5" />
                <span>全局搜索…</span>
              </span>
              <kbd className="rounded-xs border border-border bg-panel px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl K
              </kbd>
            </button>
          </div>

          <nav className="flex-1 space-y-0.5 overflow-y-auto p-3" aria-label="主导航">
            <p className="stencil mb-1.5 px-2 text-[10px] text-muted-foreground">FACTORY MODULES</p>
            {visibleNav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                title={n.label}
                aria-label={n.label}
                className="flex items-center gap-2.5 rounded-sm border-l-2 border-transparent px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
                activeProps={{
                  className:
                    "flex items-center gap-2.5 rounded-sm border-l-2 border-primary bg-sidebar-accent px-3 py-2 text-sm font-medium text-sidebar-accent-foreground",
                }}
              >
                <n.icon className="size-4 shrink-0" />
                <span className="flex-1">{n.label}</span>
                {n.to === "/inbox" && inboxBadge > 0 && (
                  <span
                    aria-label={`${inboxBadge} 条待处理`}
                    className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none text-primary-foreground tabular-nums"
                  >
                    {badgeText}
                  </span>
                )}
              </Link>
            ))}
          </nav>

          <div className="hazard-stripe h-1 opacity-40" aria-hidden />

          <div className="space-y-2.5 border-t border-sidebar-border p-3">
            <ThemeSwitcher />
            <div className="rounded-sm border border-sidebar-border bg-background/50 px-2.5 py-2">
              <div className="truncate text-xs font-medium text-foreground">
                {me.profile?.display_name || me.profile?.email}
              </div>
              <div className="stencil mt-0.5 truncate text-[10px] text-muted-foreground">
                {me.global_roles.map((r) => ROLE_LABEL[r]).join(" / ") || "成员"}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setViewMode("portal");
                  nav({ to: "/portal" });
                }}
                className="flex items-center justify-center gap-1.5 rounded-sm border border-sidebar-border bg-panel px-2 py-1.5 text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <Store className="size-3.5 shrink-0" />
                <span className="truncate">切换到业务方视角</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  await signOut();
                  nav({ to: "/auth" });
                }}
                className="flex items-center justify-center gap-1.5 rounded-sm border border-sidebar-border bg-panel px-2 py-1.5 text-xs font-medium text-sidebar-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              >
                <LogOut className="size-3.5 shrink-0" />
                <span>退出登录</span>
              </button>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-panel px-4 py-3 md:hidden">
            <Link to="/apps" className="flex items-center gap-2">
              <KyndrylLogo className="h-[18px] w-auto" />
              <span className="text-xs font-semibold text-foreground">智能应用工厂</span>
            </Link>
            <nav className="flex flex-wrap items-center gap-1" aria-label="移动端导航">
              {visibleNav.map((n) => (
                <Link
                  key={n.to}
                  to={n.to}
                  title={n.label}
                  aria-label={n.label}
                  className="relative rounded-sm p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  activeProps={{ className: "relative rounded-sm bg-sidebar-accent p-2 text-sidebar-accent-foreground" }}
                >
                  <n.icon className="size-4" />
                  {n.to === "/inbox" && inboxBadge > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[9px] font-semibold leading-4 text-primary-foreground tabular-nums">
                      {badgeText}
                    </span>
                  )}
                </Link>
              ))}
              <ThemeSwitcher compact />
              <Button
                variant="ghost"
                size="icon"
                aria-label="退出登录"
                onClick={async () => {
                  await signOut();
                  nav({ to: "/auth" });
                }}
              >
                <LogOut className="size-4" />
              </Button>
            </nav>
          </header>

          <main className="min-w-0 flex-1">
            {!me.bootstrapped && (
              <div className="flex items-center justify-between gap-4 border-b border-warning/40 bg-warning/15 px-6 py-3 text-sm">
                <span>系统尚未初始化管理员。</span>
                <Button asChild size="sm" variant="outline">
                  <Link to="/bootstrap">去初始化</Link>
                </Button>
              </div>
            )}
            <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
