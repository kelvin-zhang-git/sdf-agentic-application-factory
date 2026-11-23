import { getAccessToken } from "./auth";

/** 带登录态下载接口返回的文件。path 以 /api 之后的部分传入。 */
export async function downloadFile(path: string, filename: string, type: string): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error("下载失败");
  const blob = await res.blob();
  const url = URL.createObjectURL(new Blob([blob], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
