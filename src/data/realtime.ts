import type { LiveStatus, LiveSubscription } from "./live";
import { getAccessToken, onIdentityChange } from "./auth";

interface Subscriber {
  changed: () => void;
  status: (value: LiveStatus) => void;
}

/**
 * 同标签页 SSE 连接池管理：
 * 1. 同一个标签页内所有组件共享唯一一条 EventSource 连接，避免多组件叠加占用连接槽位。
 * 2. 标签页切到后台（document.hidden === true）时立即关闭 SSE 长连接，释放 HTTP/1.1 同源 6 连接上限，
 *    防止多标签页扮演不同角色时把浏览器连接池占满导致页面点击无响应。
 * 3. 标签页切回前台时自动重连并补刷一次最新数据。
 */
const subscribers = new Set<Subscriber>();
let sharedEs: EventSource | null = null;
let sharedToken: string | null = null;
let sharedStatus: LiveStatus = "disconnected";
let listenersBound = false;

function broadcastStatus(next: LiveStatus) {
  sharedStatus = next;
  subscribers.forEach((sub) => sub.status(next));
}

function broadcastChanged() {
  subscribers.forEach((sub) => sub.changed());
}

function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

function closeShared() {
  if (sharedEs) {
    sharedEs.close();
    sharedEs = null;
  }
  sharedToken = null;
}

function ensureConnection(notifyRefreshOnOpen = false) {
  if (subscribers.size === 0) {
    closeShared();
    return;
  }
  if (typeof EventSource === "undefined") {
    broadcastStatus("disconnected");
    return;
  }
  if (isPageHidden()) {
    // 后台标签页主动释放长连接，保持静默（不回退到后台高频轮询）
    closeShared();
    return;
  }
  const token = getAccessToken();
  if (!token) {
    closeShared();
    broadcastStatus("disconnected");
    return;
  }
  if (sharedEs && sharedToken === token && sharedEs.readyState !== EventSource.CLOSED) {
    return;
  }
  closeShared();
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  sharedEs = es;
  sharedToken = token;
  es.addEventListener("changed", () => broadcastChanged());
  es.onopen = () => {
    if (sharedEs !== es) return;
    broadcastStatus("connected");
    if (notifyRefreshOnOpen) broadcastChanged();
  };
  es.onerror = () => {
    if (sharedEs !== es) return;
    // 仅在前台标签页断线时切回轮询兜底
    if (!isPageHidden()) broadcastStatus("disconnected");
  };
}

function bindGlobalListeners() {
  if (listenersBound) return;
  listenersBound = true;
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (isPageHidden()) {
        // 切后台立刻关闭连接，并暂停 live.ts 的后台定时轮询
        closeShared();
        broadcastStatus("connected");
      } else if (subscribers.size > 0) {
        // 回到前台立即补刷一次并重建 SSE 连接
        broadcastChanged();
        ensureConnection(false);
      }
    });
  }
  onIdentityChange((event) => {
    if (event === "SIGNED_OUT") {
      closeShared();
      broadcastStatus("disconnected");
    } else if (subscribers.size > 0) {
      ensureConnection(true);
    }
  });
}

/** 仅供单元测试重置内部单例状态。 */
export function resetSharedRealtimeForTest() {
  closeShared();
  subscribers.clear();
  sharedStatus = "disconnected";
}

/** 浏览器 EventSource。同标签页共享单连接，后台自动释放，前台自动重连。 */
export const userChangesSubscription = (_userId?: string): LiveSubscription => (changed, status) => {
  bindGlobalListeners();
  const sub: Subscriber = { changed, status };
  subscribers.add(sub);

  if (isPageHidden()) {
    // 初始就在后台时先不占连接，也不启动后台轮询
    status("connected");
  } else if (sharedEs && sharedToken === getAccessToken() && sharedStatus === "connected") {
    status("connected");
  } else {
    ensureConnection(false);
  }

  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0) {
      closeShared();
      sharedStatus = "disconnected";
    }
  };
};
