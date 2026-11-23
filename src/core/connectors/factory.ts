import { AppError } from "../errors";
import { GiteaConnector } from "./gitea";
import { GithubConnector, GitlabConnector } from "./vendors";
import type { CodeRepoConnector, RepoConfig } from "./types";

export function codeRepo(vendor: string, config: RepoConfig, token: string, webhookSecret = ""): CodeRepoConnector {
  if (vendor === "gitea") return new GiteaConnector(config, token, webhookSecret);
  if (vendor === "github") return new GithubConnector(config, token, webhookSecret);
  if (vendor === "gitlab") return new GitlabConnector(config, token, webhookSecret);
  throw new AppError("VALIDATION", "当前只支持把文件提交到 Gitea、GitHub 或 GitLab");
}
