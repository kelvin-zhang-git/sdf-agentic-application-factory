import { verifyHexSignature } from "./sign";
import { apiJson, apiText } from "./http";
import type { CodeRepoConnector, PullRequestInfo, RepoConfig, RepoFile } from "./types";

function stateOf(value: string | undefined, merged: boolean): PullRequestInfo["state"] {
  if (merged || value === "merged") return "merged";
  if (value === "closed") return "closed";
  return "open";
}

/** 规范化 Gitea API 根地址：允许用户直接填 http://host:3002，自动补齐 /api/v1。 */
export function normalizeGiteaApiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

export class GiteaConnector implements CodeRepoConnector {
  constructor(private readonly config: RepoConfig, private readonly token: string, private readonly webhookSecret = "") {}

  private root(): string {
    return `${normalizeGiteaApiBase(this.config.base_url)}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
  }

  async testConnection(): Promise<void> {
    await apiJson(this.root(), this.token);
  }

  async getTree(limitBytes: number): Promise<RepoFile[]> {
    const branch = this.config.default_branch || "main";
    const tree = await apiJson(`${this.root()}/git/trees/${encodeURIComponent(branch)}?recursive=true`, this.token);
    const entries = (tree.json as { tree?: { path?: string; type?: string }[] }).tree ?? [];
    const wanted = entries.filter((item) => item.type === "blob" && item.path && /^(README|package\.json|pom\.xml|pyproject\.toml|src\/index|src\/main)/i.test(item.path)).slice(0, 20);
    const files: RepoFile[] = [];
    let used = 0;
    for (const item of wanted) {
      if (used >= limitBytes) break;
      const file = await apiJson(`${this.root()}/contents/${item.path}?ref=${encodeURIComponent(branch)}`, this.token);
      const encoded = (file.json as { content?: string }).content ?? "";
      const content = Buffer.from(encoded, "base64").toString("utf8").slice(0, limitBytes - used);
      used += Buffer.byteLength(content);
      files.push({ path: item.path!, content });
    }
    return files;
  }

  async commitFiles(branch: string, message: string, files: RepoFile[]): Promise<{ url: string | null }> {
    const base = this.config.default_branch || "main";
    let exists = true;
    try { await apiJson(`${this.root()}/branches/${encodeURIComponent(branch)}`, this.token); }
    catch { exists = false; }
    let url: string | null = null;
    for (let i = 0; i < files.length; i += 15) {
      const batch = files.slice(i, i + 15);
      const body = {
        message, branch: exists || i > 0 ? branch : base, ...(exists || i > 0 ? {} : { new_branch: branch }),
        files: batch.map((file) => ({ path: file.path, operation: exists || i > 0 ? "update" : "create", content: Buffer.from(file.content, "utf8").toString("base64") })),
      };
      try {
        const saved = await apiJson(`${this.root()}/contents`, this.token, { method: "POST", body: JSON.stringify(body) });
        url = (saved.json as { commit?: { url?: string } }).commit?.url ?? url;
      } catch (error) {
        // 分支已在、文件还没有时，Gitea 会拒绝 update。改成 create 再交一次。
        const created = { ...body, files: body.files.map((file) => ({ ...file, operation: "create" })) };
        const saved = await apiJson(`${this.root()}/contents`, this.token, { method: "POST", body: JSON.stringify(created) });
        url = (saved.json as { commit?: { url?: string } }).commit?.url ?? url;
        if (!(error instanceof Error)) throw error;
      }
      exists = true;
    }
    return { url };
  }

  async listPullRequests(): Promise<PullRequestInfo[]> {
    const listed = await apiJson(`${this.root()}/pulls?state=all&limit=50`, this.token);
    const rows = Array.isArray(listed.json) ? listed.json as Record<string, unknown>[] : [];
    return rows.map((row) => ({
      id: String(row["id"] ?? ""),
      number: Number(row["number"] ?? 0),
      title: String(row["title"] ?? ""),
      body: String(row["body"] ?? ""),
      branch: String((row["head"] as { ref?: string } | undefined)?.ref ?? ""),
      url: String(row["html_url"] ?? ""),
      state: stateOf(String(row["state"] ?? ""), Boolean(row["merged"])),
      author: String((row["user"] as { login?: string } | undefined)?.login ?? ""),
    }));
  }

  async getPullRequestFiles(number: number): Promise<string[]> {
    const listed = await apiJson(`${this.root()}/pulls/${number}/files`, this.token);
    const rows = Array.isArray(listed.json) ? listed.json as { filename?: string }[] : [];
    return rows.map((row) => row.filename ?? "").filter(Boolean);
  }

  async getPullRequestDiff(number: number): Promise<string> {
    return apiText(`${this.root()}/pulls/${number}.diff`, this.token);
  }

  async commentPullRequest(number: number, body: string): Promise<void> {
    await apiJson(`${this.root()}/issues/${number}/comments`, this.token, { method: "POST", body: JSON.stringify({ body }) });
  }

  verifyWebhook(raw: string, signature: string | undefined): boolean {
    return this.webhookSecret.length > 0 && verifyHexSignature(this.webhookSecret, raw, signature);
  }
}
