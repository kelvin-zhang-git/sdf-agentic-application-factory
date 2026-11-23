// 按浏览器标签页隔离登录会话：使用 sessionStorage 存放访问令牌，避免同一浏览器多标签页登录不同角色时互相覆写。
const TOKEN_KEY = "sdf_access_token";
const VIEW_KEY = "sdf.view";
const listeners = new Set<(event: string) => void>();

function emit(event: string) {
  listeners.forEach((fn) => fn(event));
}

export function getAccessToken(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getVerifiedUser(): { id: string; email: string | null } | null {
  const token = getAccessToken();
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string; email?: string; exp?: number };
    if (!payload.sub || (payload.exp && payload.exp * 1000 < Date.now())) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return { id: payload.sub, email: payload.email ?? null };
  } catch {
    return null;
  }
}

async function postAuth(path: string, body: unknown): Promise<{ access_token: string; needsConfirm?: boolean }> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null) as { access_token?: string; error?: { message?: string } } | null;
  if (!res.ok || !json?.access_token) throw new Error(json?.error?.message ?? "登录失败");
  sessionStorage.setItem(TOKEN_KEY, json.access_token);
  sessionStorage.removeItem(VIEW_KEY);
  emit("SIGNED_IN");
  return { access_token: json.access_token, needsConfirm: false };
}

export async function signIn(email: string, password: string) {
  await postAuth("/api/public/auth/login", { email, password });
}

export async function signUp(email: string, password: string, displayName: string) {
  await postAuth("/api/public/auth/signup", { email, password, display_name: displayName });
  return { needsConfirm: false };
}

export async function signOut() {
  const token = getAccessToken();
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(VIEW_KEY);
  }
  emit("SIGNED_OUT");
  if (token) {
    await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
}

export function onIdentityChange(cb: (event: string) => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
