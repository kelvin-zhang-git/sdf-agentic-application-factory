export interface RepoFile { path: string; content: string }
export interface RepoConfig {
  base_url: string;
  owner: string;
  repo: string;
  default_branch?: string;
}

export interface PullRequestInfo {
  id: string;
  number: number;
  title: string;
  body: string;
  branch: string;
  url: string;
  state: "open" | "merged" | "closed";
  author: string;
}

export interface CodeRepoConnector {
  testConnection(): Promise<void>;
  getTree(limitBytes: number): Promise<RepoFile[]>;
  commitFiles(branch: string, message: string, files: RepoFile[]): Promise<{ url: string | null }>;
  listPullRequests(): Promise<PullRequestInfo[]>;
  getPullRequestFiles(number: number): Promise<string[]>;
  getPullRequestDiff(number: number): Promise<string>;
  commentPullRequest(number: number, body: string): Promise<void>;
  verifyWebhook(raw: string, signature: string | undefined): boolean;
}
