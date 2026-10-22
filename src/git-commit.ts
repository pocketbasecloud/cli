import { type GitRunner, runGit } from "./commands/ci.ts";

const FIELD_SEPARATOR = "\x1f";
const MAX_TITLE = 300;
const MAX_FIELD = 200;
const UNCOMMITTED = " (with uncommitted changes)";

export type DeployCommit = {
  sha: string;
  title: string;
  author: string;
  repo?: string;
};

export function githubRepoOf(remote: string): string | undefined {
  const match = remote.trim().match(
    /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export async function readDeployCommit(
  cwd: string,
  git: GitRunner = runGit,
): Promise<DeployCommit | null> {
  const head = await git(["rev-parse", "HEAD"], cwd).catch(() => null);
  if (!head || head.code !== 0 || !head.stdout) return null;
  const sha = head.stdout;

  const log = await git(
    ["log", "-1", `--format=%s${FIELD_SEPARATOR}%an`, sha],
    cwd,
  );
  const [subject = "", author = ""] = log.code === 0
    ? log.stdout.split(FIELD_SEPARATOR)
    : [];
  const status = await git(["status", "--porcelain", "--", "."], cwd);
  const dirty = status.code === 0 && status.stdout !== "";
  const title = `${subject}${dirty ? UNCOMMITTED : ""}`;

  const remote = await git(["remote", "get-url", "origin"], cwd);
  const repo = remote.code === 0 ? githubRepoOf(remote.stdout) : undefined;
  const pushed = repo
    ? (await git(["branch", "-r", "--contains", sha], cwd)).stdout !== ""
    : false;

  return {
    sha,
    title: title.slice(0, MAX_TITLE),
    author: author.slice(0, MAX_FIELD),
    ...(repo && pushed ? { repo } : {}),
  };
}
