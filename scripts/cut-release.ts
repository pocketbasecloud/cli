import { parseArgs } from "@std/cli/parse-args";
import { dirname, fromFileUrl, isAbsolute, join, resolve } from "@std/path";
import { VERSION } from "../src/version.ts";
import { assetName, TARGETS } from "./targets.ts";
import { checkPrereqs, DIST_DIR } from "./release.ts";

const RELEASE_SCRIPT = join(dirname(fromFileUrl(import.meta.url)), "release.ts");

const CLI_DIR = dirname(dirname(fromFileUrl(import.meta.url)));
const MONOREPO_DIR = dirname(CLI_DIR);
const DOCS_REFERENCE = join(
  MONOREPO_DIR,
  "langding_page_v4/src/content/docs/ci-cd/reference.md",
);
const MIN_CLI_HOOK = join(MONOREPO_DIR, "backend/pb_hooks/helpers.js");
const SYNC_SCRIPT = join(CLI_DIR, "scripts/sync-cli-to-public.sh");
const PUBLIC_REPO = "pocketbasecloud/cli";

const USAGE = `Cut a pbc release: bump the version everywhere, gate, build, and publish.

  deno task cut-release <version> [options]

Options
  --notes "<text>"     Release notes. Use --notes @path to read from a file.
                       Omit on a terminal to draft them in $EDITOR.
  --dry-run            Bump, gate, and build only. No commit, push, or release.
  --yes                Skip the confirmation prompt (required for non-TTY runs).
  --help               Show this help.

Before running, decide whether <version> is a new minimum-CLI floor. If it is,
bump MIN_CLI_VERSION in backend/pb_hooks/helpers.js and commit that first.`;

const flags = parseArgs(Deno.args, {
  boolean: ["dry-run", "yes", "help"],
  string: ["notes"],
});

function die(msg: string): never {
  console.error(`cut-release: ${msg}`);
  Deno.exit(1);
}

async function run(cmd: string[], cwd = MONOREPO_DIR): Promise<void> {
  const { code } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) die(`command failed (${code}): ${cmd.join(" ")}`);
}

async function capture(
  cmd: string[],
  cwd = MONOREPO_DIR,
): Promise<{ code: number; out: string }> {
  const { code, stdout } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "null",
  }).output();
  return { code, out: new TextDecoder().decode(stdout).trim() };
}

async function has(bin: string): Promise<boolean> {
  try {
    const { code } = await new Deno.Command(bin, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return code === 0;
  } catch {
    return false;
  }
}

function semver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(next: string, prev: string): boolean {
  const a = semver(next)!;
  const b = semver(prev)!;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function ask(question: string): boolean {
  const answer = prompt(`${question} [y/N]`)?.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function publicRepoDir(): string {
  const fromEnv = Deno.env.get("PB_PUBLIC_CLI_DIR") ?? Deno.env.get("DEST");
  if (fromEnv) return fromEnv;
  return join(Deno.env.get("HOME") ?? "", "tom/pocketbasecloud-cli");
}

async function preflight(next: string) {
  console.log("=== preflight ===");

  if (!semver(next)) die(`"${next}" is not a MAJOR.MINOR.PATCH version.`);
  if (next === VERSION) die(`${next} is already the current version.`);
  if (!isNewer(next, VERSION)) {
    die(`${next} is not newer than the current ${VERSION}.`);
  }

  for (const bin of ["git", "gh", "deno", "tar", "zip"]) {
    if (!(await has(bin))) die(`${bin} is not on PATH.`);
  }
  await checkPrereqs();

  const branch = await capture(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.out !== "main") die(`on branch "${branch.out}", not main.`);

  const dirty = await capture(["git", "status", "--porcelain"]);
  if (dirty.out) {
    die(
      "the working tree has uncommitted changes. Commit or stash them so the " +
        "release commit is only the version bump.",
    );
  }

  await run(["git", "fetch", "--quiet", "origin", "main"]);
  const ahead = await capture([
    "git",
    "rev-list",
    "--count",
    "origin/main..HEAD",
  ]);
  const behind = await capture([
    "git",
    "rev-list",
    "--count",
    "HEAD..origin/main",
  ]);
  if (behind.out !== "0") die("local main is behind origin/main. Pull first.");
  if (ahead.out !== "0") {
    die(`local main is ${ahead.out} commit(s) ahead of origin/main. Push first.`);
  }

  const dest = publicRepoDir();
  try {
    const stat = await Deno.stat(join(dest, ".git"));
    if (!stat.isDirectory) throw new Error();
  } catch {
    die(
      `public clone not found at ${dest}. Set PB_PUBLIC_CLI_DIR or run the ` +
        "one-time setup in docs/cli-public-repo-sync.md.",
    );
  }
  const remote = await capture(["git", "-C", dest, "remote", "get-url", "origin"]);
  if (!remote.out.includes(PUBLIC_REPO)) {
    die(`public clone origin is "${remote.out}", not ${PUBLIC_REPO}.`);
  }

  const existingTag = await capture([
    "gh",
    "release",
    "view",
    `v${next}`,
    "--repo",
    PUBLIC_REPO,
    "--json",
    "tagName",
  ]);
  if (existingTag.code === 0) die(`release v${next} already exists.`);

  const minCli = (await Deno.readTextFile(MIN_CLI_HOOK)).match(
    /MIN_CLI_VERSION\s*=\s*"([^"]+)"/,
  )?.[1] ?? "unknown";
  console.log(`  MIN_CLI_VERSION floor is ${minCli} (bump separately if ${next} is a new floor)`);
  console.log("  preflight ok");
}

async function resolveNotes(next: string): Promise<string> {
  if (flags.notes && flags.notes.startsWith("@")) {
    const path = flags.notes.slice(1);
    const abs = isAbsolute(path) ? path : resolve(Deno.cwd(), path);
    return (await Deno.readTextFile(abs)).trim();
  }
  if (flags.notes) return flags.notes.trim();

  if (!Deno.stdin.isTerminal()) {
    die("--notes is required for non-interactive runs.");
  }

  const lastBump = await capture([
    "git",
    "log",
    "-1",
    "--format=%H",
    "--",
    "cli/src/version.ts",
  ]);
  const log = await capture([
    "git",
    "log",
    "--format=- %s",
    `${lastBump.out}..HEAD`,
    "--",
    "cli",
  ]);
  const editor = Deno.env.get("EDITOR") ?? Deno.env.get("VISUAL") ?? "vi";
  const tmp = await Deno.makeTempFile({ suffix: ".md" });
  await Deno.writeTextFile(
    tmp,
    `${log.out}\n\n` +
      `# Lines starting with # are ignored. Write the pbc v${next} release notes\n` +
      "# above: what changed for users, and any compatibility warning (old\n" +
      "# clients and pinned pocketbasecloud/cli/action@vX.Y.Z fail against a\n" +
      "# backend that has moved past them).\n",
  );
  await run([editor, tmp], Deno.cwd());
  const text = (await Deno.readTextFile(tmp))
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();
  await Deno.remove(tmp).catch(() => {});
  if (!text) die("empty release notes.");
  return text;
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function rewrite(
  path: string,
  edit: (text: string) => string,
): Promise<boolean> {
  const before = await Deno.readTextFile(path);
  const after = edit(before);
  if (after === before) return false;
  await Deno.writeTextFile(path, after);
  return true;
}

async function bumpVersions(next: string): Promise<string[]> {
  const old = esc(VERSION);
  const quoted = new RegExp(`"${old}"`, "g");
  const actionRef = new RegExp(`/action@v${old}\\b`, "g");
  const pin = new RegExp(`(_VERSION[:=] ?)${old}\\b`, "g");

  const versionFile = join(CLI_DIR, "src/version.ts");
  const actionYml = join(CLI_DIR, "action/action.yml");

  const results: Array<[string, boolean]> = [
    [versionFile, await rewrite(versionFile, (t) => t.replace(quoted, `"${next}"`))],
    [actionYml, await rewrite(actionYml, (t) => t.replace(quoted, `"${next}"`))],
    [
      join(CLI_DIR, "action/README.md"),
      await rewrite(
        join(CLI_DIR, "action/README.md"),
        (t) => t.replace(actionRef, `/action@v${next}`),
      ),
    ],
    [
      DOCS_REFERENCE,
      await rewrite(
        DOCS_REFERENCE,
        (t) =>
          t.replace(pin, `$1${next}`).replace(actionRef, `/action@v${next}`),
      ),
    ],
  ];

  const changed = results.filter(([, did]) => did).map(([path]) => path);
  if (!changed.includes(versionFile)) {
    die(`src/version.ts still reads ${VERSION} — nothing to bump.`);
  }
  if (!changed.includes(actionYml)) {
    die("action/action.yml cli-version default did not change.");
  }
  return changed;
}

async function publish(next: string, notes: string, changed: string[]) {
  console.log("\n=== commit + push monorepo ===");
  await run(["git", "add", ...changed]);
  await run([
    "git",
    "commit",
    "-m",
    `Release pbc ${next}\n\n${notes}`,
  ]);
  await run(["git", "push", "origin", "main"]);

  console.log("\n=== sync to public repo ===");
  await run(["sh", SYNC_SCRIPT], MONOREPO_DIR);

  console.log("\n=== create GitHub release ===");
  const assets = [
    ...TARGETS.map((t) => join(DIST_DIR, assetName(t, next))),
    join(DIST_DIR, "checksums.txt"),
  ];
  await run([
    "gh",
    "release",
    "create",
    `v${next}`,
    "--repo",
    PUBLIC_REPO,
    "--title",
    `pbc v${next}`,
    "--notes",
    notes,
    ...assets,
  ]);

  const view = await capture([
    "gh",
    "release",
    "view",
    `v${next}`,
    "--repo",
    PUBLIC_REPO,
    "--json",
    "assets,url",
    "--jq",
    "(.assets | length | tostring) + \" assets — \" + .url",
  ]);
  console.log(`\ncut-release: v${next} published — ${view.out}`);
}

async function main() {
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const next = String(flags._[0] ?? "");
  if (!next) die(`missing <version>.\n\n${USAGE}`);

  await preflight(next);
  const notes = await resolveNotes(next);
  const changed = await bumpVersions(next);

  console.log("\n=== gate + build ===");
  await run(["deno", "task", "manifest"], CLI_DIR);
  await run(["deno", "run", "-A", RELEASE_SCRIPT, "--stage-only"], CLI_DIR);

  console.log("\n=== summary ===");
  await run(["git", "diff", "--stat", ...changed]);
  console.log(`\nRelease notes for pbc v${next}:\n${notes}\n`);

  if (flags["dry-run"]) {
    console.log(
      `cut-release: --dry-run — bumped ${changed.length} file(s) and staged ` +
        `dist/. Revert with:\n  git checkout -- ${
          changed.map((p) => p.replace(`${MONOREPO_DIR}/`, "")).join(" ")
        }`,
    );
    return;
  }

  if (!flags.yes) {
    if (!Deno.stdin.isTerminal()) die("pass --yes for non-interactive runs.");
    if (!ask(`Commit, push, sync, and publish v${next}?`)) {
      die("aborted. Bumped files are left in the working tree.");
    }
  }

  await publish(next, notes, changed);
}

if (import.meta.main) await main();
