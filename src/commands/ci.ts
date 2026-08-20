import { dirname, join, relative, resolve } from "@std/path";
import type { CmdCtx, Handler } from "../router.ts";
import type { ResourceKind } from "../clients/types.ts";
import { CliError } from "../errors.ts";
import { readOwnPbJson } from "../config.ts";
import { parseKind } from "../resolve/link.ts";
import { kindCommand, kindDisplay } from "../build/detect-kind.ts";
import { resolveEnvironmentName } from "../resolve/environment.ts";
import { envFileOf, mergeEnvBuild } from "../build/config.ts";
import { VERSION } from "../version.ts";

export const CI_INIT_USAGE =
  "Usage: pb cloud ci init [pb|frontend|backend] [--out <path>] [--branch <name>] [--force] [--env <name>]";

/** Runs one git subprocess and reports its exit code and trimmed stdout. Injected so tests need no real repo. */
export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string }>;

export const runGit: GitRunner = async (args, cwd) => {
  const child = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const { code, stdout } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout).trim() };
};

async function gitRoot(cwd: string, git: GitRunner): Promise<string | null> {
  const r = await git(["rev-parse", "--show-toplevel"], cwd);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

async function currentBranch(
  cwd: string,
  git: GitRunner,
): Promise<string | null> {
  const r = await git(["symbolic-ref", "--short", "HEAD"], cwd);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

/** `origin/HEAD` — used only when HEAD is detached and `--branch` was not passed. */
async function defaultBranch(
  cwd: string,
  git: GitRunner,
): Promise<string | null> {
  const r = await git(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    cwd,
  );
  if (r.code !== 0 || !r.stdout) return null;
  return r.stdout.replace(/^origin\//, "") || null;
}

/**
 * Unique per directory so `apps/web` and `packages/web` do not share a
 * workflow file or a concurrency group.
 */
export function workflowSlug(workingDirectory: string): string | undefined {
  if (workingDirectory === "." || workingDirectory === "") return undefined;
  const slug = workingDirectory.split("/").filter((p) => p && p !== ".").join(
    "-",
  );
  return slug || undefined;
}

async function isTracked(
  root: string,
  git: GitRunner,
  path: string,
): Promise<boolean> {
  const r = await git(["ls-files", "--error-unmatch", "--", path], root);
  return r.code === 0;
}

/**
 * Git and GitHub both speak forward slashes; `relative()` on Windows does not.
 * Every path that reaches a workflow file or a printed `git` command goes
 * through here.
 */
function toPosix(path: string): string {
  return path.split("\\").join("/");
}

/**
 * A YAML scalar for a value this command did not choose — a branch name, a
 * directory, an environment. Left bare when it reads back as itself, quoted
 * when it would not: `--branch` is unvalidated free text and git itself allows
 * a comma, so `branches: [feat,wip]` is a *valid* workflow listing two branches
 * that do not exist, which installs cleanly and then never fires.
 */
const YAML_PLAIN = /^[A-Za-z0-9_][A-Za-z0-9 ._/@+-]*$/;
export function yamlScalar(value: string): string {
  return YAML_PLAIN.test(value) && !value.endsWith(" ")
    ? value
    : JSON.stringify(value);
}

export type WorkflowOptions = {
  kind: ResourceKind;
  /** Repo-root-relative, forward-slash, "." at the root. */
  workingDirectory: string;
  branch: string;
  /** Set only when the caller explicitly chose a non-default environment. */
  environment?: string;
  /** cli/action version to pin, e.g. "0.5.0". Must equal VERSION — see action.test.ts. */
  version: string;
  /**
   * The workflow's own repo-root-relative path, for the `paths:` self-trigger.
   * Passed in rather than derived, so a `--out` name is what actually lands in
   * the filter — deriving it meant a renamed workflow never re-ran on its own
   * edits.
   */
  workflowPath: string;
};

/**
 * Pure YAML generator: plain data in, a workflow file out. No disk, no git,
 * no Deno.env — everything environment-dependent is resolved by the caller
 * and passed in, which is what makes this testable without a filesystem.
 */
export function renderWorkflow(opts: WorkflowOptions): string {
  const { kind, workingDirectory, branch, environment, version, workflowPath } =
    opts;
  const root = workingDirectory === ".";
  const slug = workflowSlug(workingDirectory);
  const jobName = slug ? `Deploy ${slug}` : "Deploy";
  const group = slug
    ? `deploy-${slug}-${environment ?? "production"}`
    : `deploy-${environment ?? "production"}`;
  const pathsLine = slug
    ? `\n    paths: [${yamlScalar(`${workingDirectory}/**`)}, ${
      yamlScalar(workflowPath)
    }]`
    : "";

  const withLines = [
    `          token: \${{ secrets.PB_TOKEN }}`,
    `          kind: ${kindCommand(kind)}`,
  ];
  if (!root) {
    withLines.push(
      `          working-directory: ${yamlScalar(workingDirectory)}`,
    );
  }
  if (environment) {
    withLines.push(`          env: ${yamlScalar(environment)}`);
  }

  return `# Generated by \`pb cloud ci init\`. Edit freely — re-running the
# command leaves this file alone unless you pass --force.
# See https://pocketbasecloud.com/docs/ci-cd/reference
name: ${yamlScalar(jobName)}

on:
  push:
    branches: [${yamlScalar(branch)}]${pathsLine}
  workflow_dispatch:

concurrency:
  group: ${yamlScalar(group)}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4

      - uses: pocketbasecloud/cli/action@v${version}
        with:
${withLines.join("\n")}
`;
}

/**
 * Writes the GitHub Actions workflow that deploys this directory, using the
 * official action. Needs no login — like `cloud init`, it only inspects the
 * directory (and, here, the surrounding git repo) and writes a file.
 */
export function makeCiCommands(
  deps: {
    cwd: () => string;
    git?: GitRunner;
  },
): Record<string, Handler> {
  const git = deps.git ?? runGit;

  const ciInit: Handler = async (ctx: CmdCtx) => {
    const cwd = deps.cwd();
    const own = await readOwnPbJson(cwd);
    if (!own.projectId) {
      throw new CliError(
        `No pb.json here. Deploy once from your computer first — ` +
          `\`pb cloud pb deploy\`, \`pb cloud frontend deploy\`, or ` +
          `\`pb cloud backend deploy\` — then run \`pb cloud ci init\` again.`,
        2,
      );
    }

    const token = ctx.args[0];
    let kind: ResourceKind | undefined;
    if (token) {
      const parsed = parseKind(token);
      if (!parsed) {
        throw new CliError(`Unknown kind "${token}". ${CI_INIT_USAGE}`, 2);
      }
      kind = parsed;
    } else {
      kind = own.kind;
    }
    if (!kind) {
      throw new CliError(
        `This directory is not bound to a resource, so there is no kind to ` +
          `write a workflow for. ${CI_INIT_USAGE}`,
        2,
      );
    }

    const root = await gitRoot(cwd, git);
    if (!root) {
      throw new CliError(
        `Not a git repository. \`pb cloud ci init\` writes ` +
          `.github/workflows/, which only makes sense inside one.`,
        2,
      );
    }

    const relDir = relative(root, cwd);
    const workingDirectory = relDir === "" ? "." : toPosix(relDir);
    const slug = workflowSlug(workingDirectory);
    const defaultOut = join(
      root,
      ".github",
      "workflows",
      slug ? `deploy-${slug}.yml` : "deploy.yml",
    );
    const outFlag = ctx.raw.out as string | undefined;
    // `resolve`, not `join`: an absolute --out is a path, not a suffix, and
    // joining one onto cwd silently wrote to <cwd>/abs/path.yml instead.
    const outPath = outFlag ? resolve(cwd, outFlag) : defaultOut;
    const workflowPath = toPosix(relative(root, outPath));

    // --branch wins; then HEAD; then origin/HEAD (detached); then "main".
    const branchFlag = ctx.raw.branch as string | undefined;
    let branch = branchFlag;
    let onDetachedHead = false;
    if (!branch) {
      branch = (await currentBranch(root, git)) ?? undefined;
    }
    if (!branch) {
      onDetachedHead = true;
      branch = (await defaultBranch(root, git)) ?? undefined;
    }
    if (!branch) {
      branch = "main";
    }

    const envFlag = ctx.raw.env as string | undefined;
    // `env: {}` deliberately blinds this to PB_ENV. Everywhere else PB_ENV is
    // a per-shell convenience, but here the answer is written into a file that
    // gets committed — so a variable that happened to be exported in the
    // generating shell would silently pin CI to it forever.
    const choice = resolveEnvironmentName(own, { flag: envFlag, env: {} });
    // Only written into the workflow when the caller asked for it explicitly —
    // otherwise the CLI's own default resolution (unset --env) applies on
    // every run, and a directory whose default later changes needs no
    // workflow edit to follow it.
    const environment = choice.explicit ? choice.name : undefined;

    const version = VERSION;
    const workflow = renderWorkflow({
      kind,
      workingDirectory,
      branch,
      environment,
      version,
      workflowPath,
    });

    const warnings: string[] = [];
    // An absolute path, not the bare name: a bare pathspec resolves against
    // the repo root, so in a monorepo this asked about <root>/pb.json and
    // never about the one actually being deployed.
    const pbJsonPath = join(cwd, "pb.json");
    const pbJsonRel = toPosix(relative(root, pbJsonPath));
    if (!(await isTracked(root, git, pbJsonPath))) {
      warnings.push(
        `${pbJsonRel} is not tracked by git — GitHub will not see it. Either ` +
          `\`git add ${pbJsonRel}\` and commit it, or pass --project ` +
          `<name|id> on every deploy.`,
      );
    }
    const build = mergeEnvBuild(own, choice.name);
    const envFile = envFileOf(build);
    if (envFile) {
      const envFilePath = join(cwd, envFile);
      if (!(await isTracked(root, git, envFilePath))) {
        warnings.push(
          `The env file this environment pushes ("${envFile}") is ` +
            `not in git, so CI will not find it and the deploy will fail ` +
            `with "Env file not found". Use \`pb cloud env set\` instead — ` +
            `see the CI/CD guide, Step 6.`,
        );
      }
    }
    if (!branchFlag && onDetachedHead) {
      warnings.push(
        `HEAD is not a branch, so the workflow deploys on pushes to ` +
          `"${branch}". Pass --branch <name> to pin a different one.`,
      );
    }
    if (kind === "pocketbases") {
      warnings.push(
        `The action masks this deploy's admin credentials automatically, ` +
          `but only for output it produces itself — any step you add that ` +
          `prints the deploy JSON yourself will not be masked.`,
      );
    }

    let exists = false;
    try {
      await Deno.stat(outPath);
      exists = true;
    } catch {
      // absent — nothing to guard
    }
    if (exists && ctx.raw.force !== true) {
      if (ctx.flags.json) {
        console.log(JSON.stringify({ path: outPath, written: false }));
      } else {
        console.log(`${outPath} already exists.`);
        console.log(`Pass --force to overwrite it.`);
      }
      return 0;
    }

    await Deno.mkdir(dirname(outPath), { recursive: true });
    await Deno.writeTextFile(outPath, workflow);

    if (ctx.flags.json) {
      console.log(JSON.stringify({
        path: outPath,
        kind,
        workingDirectory,
        branch,
        environment: choice.name,
        secretName: "PB_TOKEN",
        warnings,
        written: true,
      }));
    } else {
      console.log(
        `Wrote ${outPath} — deploys this ${
          kindDisplay(kind)
        } on every push to ${branch}.`,
      );
      for (const w of warnings) console.log(`Warning: ${w}`);
      console.log(``);
      console.log(`Two things left, both one-time:`);
      console.log(
        `  1. Copy your token: portal → Account → CLI access token → Copy.`,
      );
      console.log(`  2. Add it as a repository secret named PB_TOKEN:`);
      console.log(
        `     Settings → Secrets and variables → Actions → New repository secret.`,
      );
      console.log(``);
      console.log(`Then commit both files, from ${root}:`);
      console.log(
        `  git add ${workflowPath} ${pbJsonRel}`,
      );
      console.log(`  git commit -m "Deploy on push"`);
    }
    return 0;
  };

  return { "cloud ci init": ciInit };
}
