import { useEffect, useState } from "react";
import { Palette } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Kyndryl 官方矢量字标（源自 kyndryl.com 官方矢量路径，官方品牌色 #FF462D Warm Red）。
 */
export function KyndrylLogo({
  className = "h-6 w-auto",
  mono = false,
}: {
  className?: string | undefined;
  /** 若为 true 则跟随当前文字颜色，默认使用 Kyndryl 官方 #FF462D */
  mono?: boolean | undefined;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 483 153.6"
      role="img"
      aria-label="Kyndryl"
      className={cn("shrink-0 select-none", className)}
    >
      <g fill={mono ? "currentColor" : "#FF462D"}>
        <path d="M460.4,0v115.1h-13.5V0h13.5ZM187.4,36.7c-13.2,0-21.4,8.4-22.6,19.1h-.7v-17.4h-13.5v76.7h13.5v-47.8c0-12.9,6.8-18.9,18.4-18.9s19.1,6.6,19.1,19.6v47.1h13.5v-48.8c0-18.3-10.3-29.6-27.7-29.6ZM104.8,113.1h-.4l-23.4-74.6h-14l24.8,76.7h12.5l-12.6,38.4h13.5l37.2-115.1h-13.9l-23.5,74.5ZM401.1,113.1h-.4l-23.4-74.6h-14l24.8,76.7h12.5l-12.6,38.4h13.5l37.2-115.1h-13.9l-23.5,74.5ZM28.1,76.8l33.3-38.4h-16.4l-31,37h-.4V0H0v115.1h13.5v-37.6h12.8l26,37.6h15.7l-26.8-38.3h-13.1ZM331.3,55.9h-.6v-17.4h-13.5v76.7h13.5v-48c0-12.9,7.4-17.6,19.9-17.6s6.1.4,8.3.9v-13.1c-1.1-.4-3.6-.8-6.4-.8-11.8,0-19.7,7.9-21.2,19.2ZM286.3,0h13.5v115.1h-13.5v-17.4h-.6c-1.3,10.7-9.5,19.1-25.1,19.1s-32.5-15.1-32.5-40.2,13.5-40.2,32.5-40.2,23.8,8.4,25.1,19.1h.6V0ZM286.3,66.7c0-12.9-9.7-18.2-21.8-18.2s-22.3,7.9-22.3,28.2,9.6,28.2,22.3,28.2,21.8-5.2,21.8-18.2v-20.2Z" />
        <path d="M479.9,109.8c0,3-2.4,5.3-5.3,5.3s-5.3-2.5-5.3-5.3,2.4-5.3,5.3-5.3c2.9,0,5.3,2.4,5.3,5.3ZM478.8,109.8c0-2.5-1.9-4.4-4.4-4.4s-4.4,1.9-4.4,4.4,1.9,4.4,4.4,4.4,4.4-1.9,4.4-4.4ZM475.7,110.3l1.5,2.5h-1.2l-1.3-2.4h-1.1v2.4h-1.2v-6.1h2.4c1.5,0,2.4.7,2.4,1.8s-.4,1.5-1.3,1.8ZM473.4,107.7v1.9h1.2c.8,0,1.2-.4,1.2-1s-.4-1-1.2-1h-1.2Z" />
      </g>
    </svg>
  );
}

/** K 字简标（用于窄屏折叠侧栏） */
export function KyndrylMark({ className = "size-7" }: { className?: string | undefined }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm bg-[#FF462D] font-sans text-sm font-bold lowercase tracking-tight text-white select-none",
        className,
      )}
      aria-label="Kyndryl"
    >
      k
    </span>
  );
}

/** Kyndryl + Enterprise SDF Platform 组合标识 */
export function BrandLockup({
  subtitle = "智能应用工厂",
  compact = false,
  className,
}: {
  subtitle?: string | undefined;
  compact?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-2.5">
        <KyndrylLogo className={compact ? "h-[18px] w-auto" : "h-[22px] w-auto"} />
        <span className="h-3.5 w-px bg-border" aria-hidden />
        <span className="stencil text-[10px] font-medium text-muted-foreground">SDF Platform</span>
      </div>
      {subtitle ? (
        <div className="text-xs font-semibold tracking-tight text-foreground">{subtitle}</div>
      ) : null}
    </div>
  );
}

export type SdfTheme = "kyndryl" | "arctic" | "midnight";
const THEME_KEY = "sdf_theme";
const THEMES: { id: SdfTheme; label: string; dot: string }[] = [
  { id: "kyndryl", label: "经典红白", dot: "bg-[#FF462D]" },
  { id: "arctic", label: "极地蓝白", dot: "bg-[#0284C7]" },
  { id: "midnight", label: "暗夜深空", dot: "bg-[#6366F1]" },
];

export function applyTheme(theme: SdfTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "kyndryl") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  root.classList.toggle("dark", theme === "midnight");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 忽略无痕模式存储限制
  }
}

export function initSavedTheme(): SdfTheme {
  if (typeof window === "undefined") return "kyndryl";
  try {
    const saved = localStorage.getItem(THEME_KEY) as SdfTheme | null;
    if (saved === "kyndryl" || saved === "arctic" || saved === "midnight") {
      applyTheme(saved);
      return saved;
    }
  } catch {
    // 忽略存储读取异常
  }
  return "kyndryl";
}

export function ThemeSwitcher({ compact = false }: { compact?: boolean | undefined }) {
  const [theme, setTheme] = useState<SdfTheme>("kyndryl");
  useEffect(() => {
    setTheme(initSavedTheme());
  }, []);

  function cycle() {
    const idx = THEMES.findIndex((t) => t.id === theme);
    const next = THEMES[(idx + 1) % THEMES.length]!;
    setTheme(next.id);
    applyTheme(next.id);
  }

  if (compact) {
    const current = THEMES.find((t) => t.id === theme) ?? THEMES[0]!;
    return (
      <button
        type="button"
        onClick={cycle}
        title={`切换外观主题（当前：${current.label}）`}
        aria-label={`切换外观主题（当前：${current.label}）`}
        className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-border bg-panel px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Palette className="size-3.5" />
        <span>{current.label}</span>
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between gap-1 rounded-sm border border-sidebar-border bg-background/60 p-1" role="group" aria-label="界面主题">
      {THEMES.map((item) => {
        const active = theme === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setTheme(item.id);
              applyTheme(item.id);
            }}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-xs px-2 py-1 text-[11px] font-medium transition-colors",
              active
                ? "bg-panel text-foreground shadow-2xs ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className={cn("size-2 rounded-full", item.dot)} aria-hidden />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
