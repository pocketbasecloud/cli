import { dirname } from "@std/path";
import { VERSION } from "../version.ts";
import { compareSemverDesc } from "../local/releases.ts";
import { updateCheckPath } from "../config.ts";
import { fetchManifest } from "./release.ts";
import { detectInstall, manualCommand } from "./upgrade.ts";

/**
 * The passive half of `pb upgrade --check`: one line, after the command has
 * already done its work, when a newer pb exists.
 *
 * "Background" here means the cost is amortised, not that work outlives the
 * process — `Deno.exit` kills pending ops, so a fire-and-forget fetch would be
 * cancelled before it resolved and never write anything. Instead the answer is
 * cached on disk: every invocation reads a file, and at most one a day pays for
 * a network call, itself timeboxed so a slow GitHub cannot hold a command open.
 */

/** How long a check is trusted before the next command looks again. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

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

type Cache = { checkedAt: number; latest: string };

/**
 * Reasons to stay quiet. A notice is a courtesy, so anything that makes it
 * noise — or corrupts output something else is parsing — outranks showing it.
 */
export function suppressed(
  argv: string[],
  deps: Pick<NotifyDeps, "env" | "isTTY">,
): boolean {
  // --json is a contract: stdout is parsed, and stderr is read on failure.
  if (argv.includes("--json")) return true;
  // `pb upgrade` reports both versions itself; a nudge under it is a stutter.
  if (argv[0] === "upgrade") return true;
  if (!deps.isTTY()) return true;
  if (deps.env("PB_NO_UPDATE_CHECK")) return true;
  if (deps.env("CI")) return true;
  return false;
}

/** The line a user sees, naming the command that works for their install. */
export function notice(latest: string, execPath: string): string {
  const install = detectInstall(execPath);
  const command = install.kind === "standalone"
    ? "pb upgrade"
    : manualCommand(install.kind);
  return `\nUpdate available: pb ${VERSION} → ${latest}. Run \`${command}\`.`;
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
    return { checkedAt: c.checkedAt, latest: c.latest };
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
 * The newest published pb, from cache when it is fresh enough.
 *
 * A failed lookup is cached as "current" rather than left unset: offline, the
 * alternative is retrying on every single command, which is far worse than
 * being a day late with a notice.
 */
async function latestVersion(deps: NotifyDeps): Promise<string> {
  const path = updateCheckPath();
  const cached = await readCache(deps, path);
  if (cached && deps.now() - cached.checkedAt < CHECK_TTL_MS) {
    return cached.latest;
  }
  let latest: string;
  try {
    const manifest = await fetchManifest((input, init) =>
      deps.fetch(input, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );
    latest = manifest.version;
  } catch {
    latest = cached?.latest ?? VERSION;
  }
  await writeCache(deps, path, { checkedAt: deps.now(), latest });
  return latest;
}

/** Prints the update notice when there is one. Never throws, never fails. */
export async function notifyUpdate(
  argv: string[],
  deps: NotifyDeps,
): Promise<void> {
  try {
    if (suppressed(argv, deps)) return;
    const latest = await latestVersion(deps);
    // compareSemverDesc sorts newest-first: positive means latest is newer.
    if (compareSemverDesc(VERSION, latest) <= 0) return;
    deps.write(notice(latest, deps.execPath()));
  } catch {
    // A courtesy line must never be why a command looks like it failed.
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
