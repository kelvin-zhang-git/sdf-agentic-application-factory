import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { describeError } from "../lib/error-capture";
import { onIdentityChange } from "@/data/auth";
import { Toaster } from "@/components/ui/sonner";
import { ApiError } from "@/data/http";
import { RouteError } from "@/components/sdf/RouteError";
import { BrandLockup, initSavedTheme } from "@/components/sdf/KyndrylBrand";
import { installClientReporting } from "@/data/diagnostics";

function NotFoundComponent() {
  return (
    <div className="blueprint-grid flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="panel-surface w-full max-w-md rounded-md p-8 text-center">
        <div className="mb-5 flex justify-center">
          <BrandLockup compact subtitle="" />
        </div>
        <p className="stencil text-[11px] text-primary">ERROR 404</p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-foreground tabular-nums">404</h1>
        <h2 className="mt-2 text-lg font-semibold text-foreground">页面不存在</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          您访问的页面不存在或已被移动。
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            返回工作台
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  useEffect(() => {
    if (!(error instanceof ApiError)) {
      console.error(describeError(error));
    }
  }, [error]);

  if (error instanceof ApiError) return <RouteError error={error} reset={reset} />;

  return (
    <div className="blueprint-grid flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="panel-surface w-full max-w-md rounded-md p-8 text-center">
        <p className="stencil text-[11px] text-primary">RUNTIME EXCEPTION</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
          页面出错
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          页面加载时出错，可以重试或返回首页。
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            重试
          </button>
          <a
            href="/"
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-panel px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            返回首页
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Kyndryl SDF · 智能应用工厂" },
      { name: "description", content: "Kyndryl Enterprise SDF Platform - 智能体起草、人来确认的企业级软件交付平台。" },
      { property: "og:title", content: "Kyndryl SDF · 智能应用工厂" },
      { property: "og:description", content: "智能体起草、人来确认的企业级软件交付平台。" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;600;700&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  useEffect(() => {
    initSavedTheme();
    return installClientReporting();
  }, []);
  useEffect(
    () =>
      onIdentityChange((event) => {
        router.invalidate();
        if (event === "SIGNED_OUT") queryClient.clear();
        else queryClient.invalidateQueries();
      }),
    [router, queryClient],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster richColors position="top-center" />
    </QueryClientProvider>
  );
}
