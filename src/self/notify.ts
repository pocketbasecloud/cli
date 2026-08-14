import { dirname } from "@std/path";
import { VERSION } from "../version.ts";
import { compareSemverDesc } from "../local/releases.ts";
import { updateCheckPath } from "../config.ts";
import { parseGlobal } from "../router.ts";
import { fetchManifest } from "./release.ts";
import { detectInstall, manualCommand } from "./upgrade.ts";

/**
 * The passive half of `pb upgrade --check`: one line, on every command, when a
 * newer pb exists.
 *
 * "Background" here means the cost is amortised, not that work outlives the
 * process — `Deno.exit` kills pending ops, so a fire-and-forget fetch would be
 * cancelled before it resolved and never write anything. Instead the answer is
 * cached on disk: every invocation reads a file, and at most one a day pays for
 * a network call, itself timeboxed so a slow GitHub cannot hold a command open.
 *
 * That cache is what lets the notice run *twice* per invocation (see
 * {@link NotifyOpts.before}). Printing only after the command was the original
 * design and it has one hole big enough to matter: `pb cloud logs --follow`
 * never returns, so it never printed at all — and on a long deploy the line
 * landed under a screenful of progress output. A pass that answers from cache
 * only can run first for free, which is the pass nearly every command hits.
 */

/** How long a successful check is trusted before the next command looks again. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a *failed* check is trusted. Much shorter than a successful one, and
 * deliberately: a failure is not an answer, it is the absence of one, so
 * carrying it for a day would hide a real update behind a single blip — being
 * offline for a minute, or a GitHub slower than {@link FETCH_TIMEOUT_MS}. Still
 * long enough that an offline machine does not retry on every command, which is
 * the thing the cache exists to prevent.
 */
export const FAIL_TTL_MS = 60 * 60 * 1000;

/** Bounds the once-a-day call. Missing the notice beats delaying the exit. */
export const FETCH_TIMEOUT_MS = 1500;

export type NotifyDeps = {
  fetch: typeof fetch;
  env: (k: string) => string | undefined;
  now: () => number;
  readTextFile: (p: string) => Promise<string>;
  writeTextFile: (p: string, d: string) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
  /** Where the notice goes — stderr, so a piped stdout stays machine-readable. */
  write: (s: string) => void;
  /** False when output is redirected, i.e. nobody is there to read a nudge. */
  isTTY: () => boolean;
  /** Absolute path of the running binary, which decides the command to suggest. */
  execPath: () => string;
};

type Cache = {
  checkedAt: number;
  latest: string;
  /** False when the lookup failed and `latest` is a fallback, not an answer. */
  ok: boolean;
};

export type NotifyOpts = {
  /**
   * Print before the command rather than after it. A pass that runs first must
   * not cost anything, so it answers from the cache alone and stays quiet when
   * the cache is missing or stale — the pass after the command is the one that
   * refreshes it, and the one that speaks on a first-ever run.
   */
  before?: boolean;
};

/**
 * What a pass concluded, which is what tells the caller whether a second one
 * has anything left to do.
 *
 * - `announced` — the notice was printed.
 * - `quiet` — there is nothing to say, and looking again would not change that.
 * - `unknown` — no answer without a network lookup, which only a pass running
 *   `before` the command declines to make. Never returned otherwise.
 */
export type NotifyResult = "announced" | "quiet" | "unknown";

/**
 * Reasons to stay quiet. A notice is a courtesy, so anything that makes it
 * noise — or corrupts output something else is parsing — outranks showing it.
 */
export function suppressed(
  argv: string[],
  deps: Pick<NotifyDeps, "env" | "isTTY">,
): boolean {
  // Parsed rather than scanned, so this agrees with what `dispatch` sees:
  // `pb --profile x upgrade` is still the upgrade command, and `--data=--json`
  // carries a value that is not the --json flag.
  const { path, ctx } = parseGlobal(argv);
  // --json is a contract: stdout is parsed, and stderr is read on failure.
  if (ctx.flags.json) return true;
  // `pb upgrade` reports both versions itself; a nudge under it is a stutter.
  if (path[0] === "upgrade") return true;
  if (!deps.isTTY()) return true;
  if (deps.env("PB_NO_UPDATE_CHECK")) return true;
  if (deps.env("CI")) return true;
  return false;
}

/**
 * The line a user sees, naming the command that works for their install. Bare:
 * whichever side of the command it lands on supplies its own spacing.
 */
export function notice(latest: string, execPath: string): string {
  const install = detectInstall(execPath);
  const command = install.kind === "standalone"
    ? "pb upgrade"
    : manualCommand(install.kind);
  return `Update available: pb ${VERSION} → ${latest}. Run \`${command}\`.`;
}

async function readCache(
  deps: NotifyDeps,
  path: string,
): Promise<Cache | null> {
  try {
    const c = JSON.parse(await deps.readTextFile(path)) as Partial<Cache>;
    if (typeof c.checkedAt !== "number" || typeof c.latest !== "string") {
      return null;
    }
    // A cache written before `ok` existed only ever held a real answer.
    return { checkedAt: c.checkedAt, latest: c.latest, ok: c.ok !== false };
  } catch {
    return null; // Absent or corrupt reads the same: look again.
  }
}

async function writeCache(
  deps: NotifyDeps,
  path: string,
  c: Cache,
): Promise<void> {
  try {
    await deps.mkdir(dirname(path));
    await deps.writeTextFile(path, JSON.stringify(c));
  } catch {
    // A cache that cannot be written only costs another check next time.
  }
}

/**
 * The newest published pb, from cache when it is fresh enough, or null when
 * there is nothing to say without paying for a lookup `cacheOnly` forbids.
 *
 * A failed lookup is cached as "current" rather than left unset: offline, the
 * alternative is retrying on every single command, which is far worse than
 * being an hour late with a notice. It is marked as a failure so it expires on
 * {@link FAIL_TTL_MS} instead of being trusted for a whole day.
 */
async function latestVersion(
  deps: NotifyDeps,
  cacheOnly: boolean,
): Promise<string | null> {
  const path = updateCheckPath();
  const cached = await readCache(deps, path);
  const ttl = cached?.ok === false ? FAIL_TTL_MS : CHECK_TTL_MS;
  if (cached && deps.now() - cached.checkedAt < ttl) return cached.latest;
  // A stale cache is not repeated: it would be claiming an update the last
  // successful look saw, which the refresh below is about to re-check anyway.
  if (cacheOnly) return null;

  let latest: string;
  let ok = true;
  try {
    const manifest = await fetchManifest((input, init) =>
      deps.fetch(input, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );
    latest = manifest.version;
  } catch {
    ok = false;
    latest = cached?.latest ?? VERSION;
  }
  await writeCache(deps, path, { checkedAt: deps.now(), latest, ok });
  return latest;
}

/**
 * Prints the update notice when there is one. Never throws, never fails.
 *
 * The {@link NotifyResult} is what stops the two passes around a command from
 * saying the same thing twice — or from both reading the same cache file to
 * reach the same conclusion.
 */
export async function notifyUpdate(
  argv: string[],
  deps: NotifyDeps,
  opts: NotifyOpts = {},
): Promise<NotifyResult> {
  try {
    if (suppressed(argv, deps)) return "quiet";
    const before = opts.before === true;
    const latest = await latestVersion(deps, before);
    if (latest === null) return "unknown";
    // compareSemverDesc sorts newest-first: positive means latest is newer.
    if (compareSemverDesc(VERSION, latest) <= 0) return "quiet";
    // The blank line always separates the notice from the command's own
    // output, so it goes below the line when printing first and above it when
    // printing last.
    const line = notice(latest, deps.execPath());
    deps.write(before ? `${line}\n` : `\n${line}`);
    return "announced";
  } catch {
    // A courtesy line must never be why a command looks like it failed.
    return "quiet";
  }
}

export function buildNotifyDeps(): NotifyDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    env: (k) => Deno.env.get(k),
    now: () => Date.now(),
    readTextFile: (p) => Deno.readTextFile(p),
    writeTextFile: (p, d) => Deno.writeTextFile(p, d),
    mkdir: async (p) => {
      await Deno.mkdir(p, { recursive: true });
    },
    write: (s) => console.error(s),
    isTTY: () => Deno.stderr.isTerminal(),
    execPath: () => Deno.execPath(),
  };
}
