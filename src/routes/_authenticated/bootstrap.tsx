import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { bootstrapAdmin } from "@/data/sdf";
import { ErrorBox } from "@/components/sdf/common";
import { BrandLockup } from "@/components/sdf/KyndrylBrand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/bootstrap")({
  head: () => ({ meta: [
    { title: "初始化管理员 · SDF 智能应用工厂" },
    { name: "description", content: "使用部署初始化口令设置首位平台管理员" },
    { name: "robots", content: "noindex" },
    { property: "og:title", content: "初始化管理员 · SDF 智能应用工厂" },
    { property: "og:description", content: "使用部署初始化口令设置首位平台管理员" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: BootstrapPage,
});

function BootstrapPage() {
  const [token, setToken] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await bootstrapAdmin(token); await qc.invalidateQueries(); nav({ to: "/admin" }); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  }
  return (
    <div className="blueprint-grid flex min-h-[100dvh] items-center justify-center bg-background p-6">
      <form onSubmit={submit} className="panel-surface w-full max-w-md space-y-4 rounded-md p-6 sm:p-8">
        <BrandLockup compact subtitle="" />
        <div>
          <p className="stencil text-[10px] text-primary">SYSTEM BOOTSTRAP</p>
          <h1 className="mt-1 text-xl font-semibold">初始化平台管理员</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">系统尚未初始化。输入部署时配置的初始化口令，当前账号将成为第一位平台管理员。初始化完成后此入口自动关闭。</p>
        </div>
        <div className="space-y-2"><Label htmlFor="tk">初始化口令</Label>
          <Input id="tk" type="password" required autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></div>
        <ErrorBox error={err} />
        <Button type="submit" disabled={busy} className="w-full">{busy ? "初始化中…" : "成为管理员"}</Button>
      </form>
    </div>
  );
}
