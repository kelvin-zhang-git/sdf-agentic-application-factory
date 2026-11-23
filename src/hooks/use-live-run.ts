import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { setLiveMode, startLiveRefresh, type LiveSubscription } from "@/data/live";
import { userChangesSubscription } from "@/data/realtime";

/** 默认走 SSE（同标签页共享单连接、后台自动释放）。连接成功时停掉轮询，断开后每 5 秒刷新。 */
export function useLiveRun(queryKey: QueryKey, subscribe?: LiveSubscription, intervalMs = 5000) {
  const client = useQueryClient();
  const keyHash = JSON.stringify(queryKey);
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  const subRef = useRef(subscribe);
  subRef.current = subscribe;

  useEffect(() => startLiveRefresh(() => {
    void client.invalidateQueries({ queryKey: keyRef.current });
  }, (changed, status) => (subRef.current ?? userChangesSubscription())(changed, (value) => {
    setLiveMode(value === "connected" ? "live" : "poll");
    status(value);
  }), intervalMs), [client, keyHash, intervalMs]);
}
