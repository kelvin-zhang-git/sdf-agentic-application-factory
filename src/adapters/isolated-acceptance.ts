// 合并请求认领后，把分支放到共享目录，交给隔离运行器执行。本进程不运行仓库代码。
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { AppError } from "@/core/errors";
import { readableSources, secretScanOf, SEMGREP_RULES, unsafeArchiveName } from "@/core/isolated-archive";
import { serviceQuery } from "./pg-client";
import { downloadBranchArchive } from "./stage2-store";

const execFileAsync = promisify(execFile);
const WAIT_MS = 120_000;

function storageRoot(): string {
  return process.env["SDF_STORAGE_DIR"] || "/data/storage";
}

async function listArchive(bytes: Buffer, archivePath: string): Promise<string[]> {
  await writeFile(archivePath, bytes);
  const listed = await execFileAsync("tar", ["-tzf", archivePath], { maxBuffer: 2_000_000 });
  return listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** 认领之后排队。失败只记在任务上，不挡住合并请求同步。 */
export function scheduleIsolatedAcceptance(appId: string, mergeRequestId: string): void {
  void runIsolatedAcceptance(appId, mergeRequestId, false).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message.slice(0, 500) : "隔离验收失败";
    await serviceQuery()(
      `UPDATE public.acceptance_jobs SET status = 'failed', error_message = $2, finished_at = now()
       WHERE merge_request_id = $1 AND status = 'running'`,
      [mergeRequestId, message],
    ).catch(() => undefined);
  });
}

export async function runIsolatedAcceptance(appId: string, mergeRequestId: string, force = false): Promise<{ tests: number; findings: number }> {
  const rows = await serviceQuery()(
    `SELECT branch, state, task_id FROM public.merge_requests WHERE id = $1 AND app_id = $2`,
    [mergeRequestId, appId],
  );
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "合并请求不存在");
  if (!row["task_id"]) throw new AppError("VALIDATION", "合并请求还没有认领到任务，先认领再验收");
  const branch = String(row["branch"] ?? "");
  if (!branch) throw new AppError("VALIDATION", "合并请求没有分支名");
  if (!force) {
    const recent = await serviceQuery()(
      `SELECT id FROM public.acceptance_jobs WHERE merge_request_id = $1 AND created_at > now() - interval '15 minutes' LIMIT 1`,
      [mergeRequestId],
    );
    if (recent[0]) return { tests: 0, findings: 0 };
  }
  const job = await serviceQuery()(
    `INSERT INTO public.acceptance_jobs(app_id, merge_request_id, status) VALUES ($1,$2,'running') RETURNING id`,
    [appId, mergeRequestId],
  );
  const jobId = String(job[0]?.["id"] ?? randomUUID());
  const root = join(storageRoot(), "acceptance", jobId);
  const src = join(root, "src");
  const archivePath = join(root, "archive.tar.gz");
  const unpack = join(root, "unpack");
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "rules"), { recursive: true });
  try {
    const archive = await downloadBranchArchive(appId, branch);
    if (archive.length > 20 * 1024 * 1024) throw new AppError("VALIDATION", "分支压缩包超过 20 MB");
    const names = await listArchive(archive, archivePath);
    if (names.some(unsafeArchiveName)) throw new AppError("VALIDATION", "压缩包包含越界路径，已拒绝解压");
    await mkdir(unpack, { recursive: true });
    await execFileAsync("tar", ["-xzf", archivePath, "-C", unpack]);
    const { rename, readdir } = await import("node:fs/promises");
    const tops = await readdir(unpack);
    if (tops.length === 1) await rename(join(unpack, tops[0]!), src);
    else await rename(unpack, src);
    await writeFile(join(root, "rules", "secrets.yml"), SEMGREP_RULES, "utf8");
    await writeFile(join(root, "ready"), "1", "utf8");
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      try {
        await stat(join(root, "done"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    try {
      await stat(join(root, "done"));
    } catch {
      throw new AppError("VALIDATION", "隔离运行器没有在两分钟内完成。请确认 sdf-runner 已启动");
    }
    const junit = await readFile(join(root, "out", "junit.xml"), "utf8").catch(() => "");
    const semgrep = await readFile(join(root, "out", "semgrep.sarif"), "utf8").catch(() => "");
    const scanned = secretScanOf(await readableSources(src));
    const sarif = semgrep.includes("\"runs\"") ? semgrep : scanned;
    const { storeReports } = await import("./stage2-store");
    const saved = await storeReports(appId, junit || null, sarif, { mergeRequestId });
    await serviceQuery()(`UPDATE public.acceptance_jobs SET status = 'succeeded', finished_at = now() WHERE id = $1`, [jobId]);
    return saved;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "隔离验收失败";
    await serviceQuery()(`UPDATE public.acceptance_jobs SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1`, [jobId, message]).catch(() => undefined);
    throw error;
  } finally {
    // 无论验收成功、超时还是报错，均立即删除源码目录与压缩包，保留 out/ 日志供排障。
    await Promise.all([
      rm(src, { recursive: true, force: true }).catch(() => undefined),
      rm(unpack, { recursive: true, force: true }).catch(() => undefined),
      rm(archivePath, { force: true }).catch(() => undefined),
    ]);
  }
}
