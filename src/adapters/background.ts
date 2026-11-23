// Per-request background execution. Workers: the request's ctx.waitUntil, or the runtime-level
// waitUntil from "cloudflare:workers" when the request context did not propagate (otherwise the
// isolate stops right after the response and claimed work dies mid-step). Dev server: plain promise.
import { AsyncLocalStorage } from "node:async_hooks";
type WaitCtx = { waitUntil?: (p: Promise<unknown>) => void } | undefined;
export const requestCtx = new AsyncLocalStorage<WaitCtx>();
// Fallback when AsyncLocalStorage does not propagate in the deployed runtime: the context of the
// request currently being handled by this isolate (set at the entry before any await).
let entryCtx: WaitCtx;
export function setEntryCtx(ctx: WaitCtx) { entryCtx = ctx; }
export type DeferMode = "ctx" | "entry" | "runtime" | "none";
export let lastDeferMode: DeferMode = "none";
const CF = "cloudflare:workers";
let cfWait: Promise<((p: Promise<unknown>) => void) | null> | null = null;
function runtimeWaitUntil() {
  cfWait ??= import(/* @vite-ignore */ CF).then((m: { waitUntil?: (p: Promise<unknown>) => void }) => m.waitUntil ?? null).catch(() => null);
  return cfWait;
}
export function defer(task: () => Promise<unknown>): void {
  const p = Promise.resolve().then(task).catch((e: unknown) => console.error("[background-failed]", e instanceof Error ? e.message.slice(0, 200) : "error"));
  const ctx = requestCtx.getStore();
  if (ctx?.waitUntil) { lastDeferMode = "ctx"; ctx.waitUntil(p); return; }
  if (entryCtx?.waitUntil) { lastDeferMode = "entry"; try { entryCtx.waitUntil(p); return; } catch { /* finished request */ } }
  lastDeferMode = "runtime";
  void runtimeWaitUntil().then((w) => { if (w) w(p); else { lastDeferMode = "none"; console.warn("[background-unguarded]"); } });
}
