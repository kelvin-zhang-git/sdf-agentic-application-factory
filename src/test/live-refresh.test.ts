import { afterEach, describe, expect, it, vi } from "vitest";
import { startLiveRefresh, type LiveStatus } from "@/data/live";
import { resetSharedRealtimeForTest, userChangesSubscription } from "@/data/realtime";

afterEach(() => {
  vi.useRealTimers();
  resetSharedRealtimeForTest();
});
describe("live refresh foundation", () => {
  it("defaults to polling every 5 seconds", () => {
    vi.useFakeTimers(); const refresh = vi.fn(); const stop = startLiveRefresh(refresh);
    vi.advanceTimersByTime(4999); expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(refresh).toHaveBeenCalledTimes(1); stop();
  });
  it("stops polling while connected and resumes after disconnect", () => {
    vi.useFakeTimers(); const refresh = vi.fn(); let update: ((value: LiveStatus) => void) | undefined;
    const stop = startLiveRefresh(refresh, (_, status) => { update = status; return () => {}; });
    update?.("connected"); vi.advanceTimersByTime(10000); expect(refresh).not.toHaveBeenCalled();
    update?.("disconnected"); vi.advanceTimersByTime(5000); expect(refresh).toHaveBeenCalledTimes(1); stop();
  });
  it("refreshes on an event and releases timers and subscription on cleanup", () => {
    vi.useFakeTimers(); const refresh = vi.fn(); const unsubscribe = vi.fn(); let event: (() => void) | undefined;
    const stop = startLiveRefresh(refresh, (changed) => { event = changed; return unsubscribe; });
    event?.(); expect(refresh).toHaveBeenCalledTimes(1); stop(); event?.();
    vi.advanceTimersByTime(10000); expect(refresh).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("keeps polling when subscription setup fails", () => {
    vi.useFakeTimers(); const refresh = vi.fn(); const stop = startLiveRefresh(refresh, () => { throw new Error("offline"); });
    vi.advanceTimersByTime(5000); expect(refresh).toHaveBeenCalledTimes(1); stop();
  });
  it("同标签页多订阅共享单条 SSE 连接，切后台自动释放、切回前台重连并刷新", () => {
    const instances: { url: string; readyState: number; closed: boolean; onopen: (() => void) | null; onerror: (() => void) | null; listeners: Record<string, (() => void)[]> }[] = [];
    class FakeEventSource {
      static CLOSED = 2;
      readyState = 1;
      closed = false;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      listeners: Record<string, (() => void)[]> = {};
      constructor(public url: string) { instances.push(this); }
      addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
      close() { this.closed = true; this.readyState = 2; }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    sessionStorage.setItem("sdf_access_token", "tok_test_123");
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

    const c1 = vi.fn(); const s1 = vi.fn();
    const c2 = vi.fn(); const s2 = vi.fn();
    const unsub1 = userChangesSubscription()(c1, s1);
    const unsub2 = userChangesSubscription()(c2, s2);
    // 两个订阅者只建立 1 条 EventSource 连接
    expect(instances).toHaveLength(1);
    instances[0]!.onopen?.();
    expect(s1).toHaveBeenCalledWith("connected");
    expect(s2).toHaveBeenCalledWith("connected");

    // 切后台释放连接
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(instances[0]!.closed).toBe(true);

    // 切回前台触发补刷并重连
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(c1).toHaveBeenCalledTimes(1);
    expect(c2).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);

    // 全部退订后关闭连接
    unsub1();
    expect(instances[1]!.closed).toBe(false);
    unsub2();
    expect(instances[1]!.closed).toBe(true);

    sessionStorage.removeItem("sdf_access_token");
    vi.unstubAllGlobals();
  });
});