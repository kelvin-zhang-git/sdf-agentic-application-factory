export type LiveStatus = "connected" | "disconnected";
export type LiveMode = "live" | "poll";
export type LiveSubscription = (changed: () => void, status: (value: LiveStatus) => void) => () => void;

let mode: LiveMode = "poll";
const modeListeners = new Set<() => void>();
export function setLiveMode(next: LiveMode) {
  if (mode === next) return;
  mode = next;
  modeListeners.forEach((fn) => fn());
}
export function getLiveMode(): LiveMode { return mode; }
export function subscribeLiveMode(fn: () => void) {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

/** Poll until connected; resume polling on disconnect. No business data is cached here. */
export function startLiveRefresh(refresh: () => void, subscribe?: LiveSubscription, intervalMs = 5000) {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const changed = () => { if (!stopped) refresh(); };
  const status = (value: LiveStatus) => {
    if (stopped) return;
    if (value === "connected") {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    } else if (timer === undefined) timer = setInterval(changed, intervalMs);
  };
  status("disconnected");
  let unsubscribe: (() => void) | undefined;
  try { unsubscribe = subscribe?.(changed, status); } catch { status("disconnected"); }
  return () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    unsubscribe?.();
  };
}