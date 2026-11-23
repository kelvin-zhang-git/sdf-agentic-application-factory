import { verifyConstantToken, verifyHexSignature } from "./sign";
import { apiJson, apiText, ConnectorHttpError } from "./http";
import type { CodeRepoConnector, PullRequestInfo, RepoConfig, RepoFile } from "./types";

function bearer(url: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return apiJson(url, token, { ...init, headers }).catch(async (error: unknown) => {
    if (error instanceof ConnectorHttpError) throw error;
    throw error;
  });
}

/** GitHub REST。验签头是 X-Hub-Signature-256。 */
export class GithubConnector implements CodeRepoConnector {
  constructor(private readonly config: RepoConfig, private readonly token: string, private readonly webhookSecret = "") {}
  private root() { return `https://api.github.com/repos/${this.config.owner}/${this.config.repo}`; }
  async testConnection() { await bearer(this.root(), this.token, { headers: { Accept: "application/vnd.github+json" } }); }
  async getTree(limitBytes: number): Promise<RepoFile[]> {
    const ref = this.config.default_branch || "main";
    const listed = await bearer(`${this.root()}/contents?ref=${encodeURIComponent(ref)}`, this.token);
    const rows = Array.isArray(listed.json) ? listed.json as { name?: string; download_url?: string }[] : [];
    const files: RepoFile[] = [];
    let used = 0;
    for (const row of rows.filter((item) => /^(README|package\.json|pom\.xml|pyproject\.toml)/i.test(item.name ?? "")).slice(0, 8)) {
      if (!row.download_url || used >= limitBytes) continue;
      const response = await fetch(row.download_url, { headers: { Authorization: `Bearer ${this.token}` } });
      const content = (await response.text()).slice(0, limitBytes - used);
      used += content.length;
      files.push({ path: row.name ?? "README", content });
    }
    return files;
  }
  async commitFiles(branch: string, message: string, files: RepoFile[]) {
    const ref = this.config.default_branch || "main";
    const base = await bearer(`${this.root()}/git/ref/heads/${encodeURIComponent(ref)}`, this.token);
    const sha = (base.json as { object?: { sha?: string } }).object?.sha ?? "";
    await bearer(`${this.root()}/git/refs`, this.token, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) }).catch(() => undefined);
    for (const file of files) {
      await bearer(`${this.root()}/contents/${file.path}`, this.token, { method: "PUT", body: JSON.stringify({ message, branch, content: Buffer.from(file.content, "utf8").toString("base64") }) });
    }
    return { url: `${this.root()}/tree/${branch}` };
  }
  async listPullRequests(): Promise<PullRequestInfo[]> {
    const listed = await bearer(`${this.root()}/pulls?state=all&per_page=50`, this.token);
    const rows = Array.isArray(listed.json) ? listed.json as Record<string, unknown>[] : [];
    return rows.map((row) => ({ id: String(row["id"] ?? ""), number: Number(row["number"] ?? 0), title: String(row["title"] ?? ""), body: String(row["body"] ?? ""), branch: String((row["head"] as { ref?: string } | undefined)?.ref ?? ""), url: String(row["html_url"] ?? ""), state: row["merged_at"] ? "merged" : row["state"] === "closed" ? "closed" : "open", author: String((row["user"] as { login?: string } | undefined)?.login ?? "") }));
  }
  async getPullRequestFiles(number: number) {
    const listed = await bearer(`${this.root()}/pulls/${number}/files`, this.token);
    return (Array.isArray(listed.json) ? listed.json as { filename?: string }[] : []).map((row) => row.filename ?? "").filter(Boolean);
  }
  async getPullRequestDiff(number: number) {
    return apiText(`${this.root()}/pulls/${number}`, this.token, { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github.diff" } });
  }
  async commentPullRequest(number: number, body: string) { await bearer(`${this.root()}/issues/${number}/comments`, this.token, { method: "POST", body: JSON.stringify({ body }) }); }
  verifyWebhook(raw: string, signature: string | undefined) { return this.webhookSecret.length > 0 && verifyHexSignature(this.webhookSecret, raw, signature); }
}

/** GitLab API v4。Webhook 用固定令牌，不做正文哈希。 */
export class GitlabConnector implements CodeRepoConnector {
  constructor(private readonly config: RepoConfig, private readonly token: string, private readonly webhookSecret = "") {}
  private id() { return encodeURIComponent(`${this.config.owner}/${this.config.repo}`); }
  private root() { return `${this.config.base_url.replace(/\/$/, "")}/api/v4/projects/${this.id()}`; }
  async testConnection() { await apiJson(this.root(), this.token, { headers: { "PRIVATE-TOKEN": this.token } }); }
  async getTree(): Promise<RepoFile[]> { return []; }
  async commitFiles(branch: string, message: string, files: RepoFile[]) {
    const saved = await apiJson(`${this.root()}/repository/commits`, this.token, { method: "POST", headers: { "PRIVATE-TOKEN": this.token }, body: JSON.stringify({ branch, start_branch: this.config.default_branch || "main", commit_message: message, actions: files.map((file) => ({ action: "create", file_path: file.path, content: file.content })) }) });
    return { url: (saved.json as { web_url?: string }).web_url ?? null };
  }
  async listPullRequests(): Promise<PullRequestInfo[]> {
    const listed = await apiJson(`${this.root()}/merge_requests?state=all`, this.token, { headers: { "PRIVATE-TOKEN": this.token } });
    const rows = Array.isArray(listed.json) ? listed.json as Record<string, unknown>[] : [];
    return rows.map((row) => ({ id: String(row["id"] ?? ""), number: Number(row["iid"] ?? 0), title: String(row["title"] ?? ""), body: String(row["description"] ?? ""), branch: String(row["source_branch"] ?? ""), url: String(row["web_url"] ?? ""), state: row["state"] === "merged" ? "merged" : row["state"] === "closed" ? "closed" : "open", author: String((row["author"] as { username?: string } | undefined)?.username ?? "") }));
  }
  async getPullRequestFiles(number: number) {
    const listed = await apiJson(`${this.root()}/merge_requests/${number}/changes`, this.token, { headers: { "PRIVATE-TOKEN": this.token } });
    return ((listed.json as { changes?: { new_path?: string }[] }).changes ?? []).map((row) => row.new_path ?? "").filter(Boolean);
  }
  async getPullRequestDiff(number: number) {
    const listed = await apiJson(`${this.root()}/merge_requests/${number}/changes`, this.token, { headers: { "PRIVATE-TOKEN": this.token } });
    return ((listed.json as { changes?: { diff?: string }[] }).changes ?? []).map((row) => row.diff ?? "").join("\n");
  }
  async commentPullRequest(number: number, body: string) { await apiJson(`${this.root()}/merge_requests/${number}/notes`, this.token, { method: "POST", headers: { "PRIVATE-TOKEN": this.token }, body: JSON.stringify({ body }) }); }
  verifyWebhook(_raw: string, signature: string | undefined) { return verifyConstantToken(this.webhookSecret, signature); }
}

export async function jiraSearch(baseUrl: string, token: string, jql: string): Promise<{ key: string; summary: string }[]> {
  const listed = await apiJson(`${baseUrl.replace(/\/$/, "")}/rest/api/2/search`, token, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ jql, fields: ["summary"], maxResults: 20 }) });
  return ((listed.json as { issues?: { key?: string; fields?: { summary?: string } }[] }).issues ?? []).map((item) => ({ key: item.key ?? "", summary: item.fields?.summary ?? "" }));
}

export async function jiraCreate(baseUrl: string, token: string, project: string, summary: string, description: string): Promise<string> {
  const saved = await apiJson(`${baseUrl.replace(/\/$/, "")}/rest/api/2/issue`, token, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ fields: { project: { key: project }, summary, description, issuetype: { name: "Task" } } }) });
  return (saved.json as { key?: string }).key ?? "";
}

export async function adoCreate(baseUrl: string, token: string, project: string, title: string): Promise<number> {
  const saved = await apiJson(`${baseUrl.replace(/\/$/, "")}/${project}/_apis/wit/workitems/$Task?api-version=7.1`, token, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`, "Content-Type": "application/json-patch+json" }, body: JSON.stringify([{ op: "add", path: "/fields/System.Title", value: title }]) });
  return Number((saved.json as { id?: number }).id ?? 0);
}

export async function postNotify(url: string, text: string): Promise<number> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msgtype: "text", text: { content: text }, content: { text } }) });
  if (!response.ok) throw new ConnectorHttpError(response.status, (await response.text()).slice(0, 180));
  return response.status;
}
