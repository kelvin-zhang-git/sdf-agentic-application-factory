export class ConnectorHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function apiJson(url: string, token: string, init: RequestInit = {}): Promise<{ status: number; json: unknown }> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `token ${token}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new ConnectorHttpError(response.status, text.slice(0, 240) || response.statusText);
  return { status: response.status, json: text ? JSON.parse(text) as unknown : null };
}

export async function apiText(url: string, token: string, init: RequestInit = {}): Promise<string> {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", `token ${token}`);
  if (!headers.has("Accept")) headers.set("Accept", "text/plain");
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new ConnectorHttpError(response.status, text.slice(0, 240) || response.statusText);
  return text;
}
