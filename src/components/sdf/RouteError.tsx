import { useState } from "react";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { errorText } from "./common";

export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <section role="alert" className="mx-auto flex min-h-64 max-w-lg flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold text-foreground">暂时无法加载</h1>
      <p className="text-sm text-muted-foreground">{errorText(error)}</p>
      <Button disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          await router.options.context.queryClient.resetQueries({ predicate: (query) => query.state.status === "error" });
          await router.invalidate();
          reset();
        } finally { setBusy(false); }
      }}>{busy ? "正在重试…" : "重试"}</Button>
    </section>
  );
}