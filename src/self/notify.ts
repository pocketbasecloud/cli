import { dirname } from "@std/path";
import { VERSION } from "../version.ts";
import { compareSemverDesc } from "../local/releases.ts";
import { readEnv, updateCheckPath } from "../config.ts";
import { commandPathOf, parseGlobalFlags } from "../globals.ts";
import { fetchManifest } from "./release.ts";
import { detectInstall, manualCommand } from "./upgrade.ts";

export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export const FAIL_TTL_MS = 60 * 60 * 1000;

export const FETCH_TIMEOUT_MS = 1500;

export type NotifyDeps = {
  fetch: typeof fetch;
  env: (k: string) => string | undefined;
  now: () => number;
  readTextFile: (p: string) => Promise<string>;
  writeTextFile: (p: string, d: string) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
  write: (s: string) => void;
  isTTY: () => boolean;
  execPath: () => string;
};

type Cache = {
  checkedAt: number;
  latest: string;
  ok: boolean;
};

export type NotifyOpts = {
  before?: boolean;
};

export type NotifyResult = "announced" | "quiet" | "unknown";

export function suppressed(
  argv: string[],
  deps: Pick<NotifyDeps, "env" | "isTTY">,
): boolean {
  const path = commandPathOf(argv);
  const globals = parseGlobalFlags(argv);
  if (globals.json) return true;
  if (path[0] === "upgrade" ||
    (path[0] === "self" && path[1] === "upgrade")) return true;
  if (!deps.isTTY()) return true;
  if (readEnv(deps.env, "NO_UPDATE_CHECK")) return true;
  if (deps.env("CI")) return true;
  return false;
}

export function notice(latest: string, execPath: string): string {
  const install = detectInstall(execPath);
  const command = install.kind === "standalone"
    ? "pbc self upgrade"
    : manualCommand(install.kind);
  if (install.kind === "npm") {
    return `Update available: pbc ${VERSION} → ${latest}. npm installs are deprecated — reinstall with \`${command}\`, then \`pbc self upgrade\` works in place.`;
  }
  return `Update available: pbc ${VERSION} → ${latest}. Run \`${command}\`.`;
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
    return { checkedAt: c.checkedAt, latest: c.latest, ok: c.ok !== false };
  } catch {
    return null;
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

async function latestVersion(
  deps: NotifyDeps,
  cacheOnly: boolean,
): Promise<string | null> {
  const path = updateCheckPath();
  const cached = await readCache(deps, path);
  const ttl = cached?.ok === false ? FAIL_TTL_MS : CHECK_TTL_MS;
  if (cached && deps.now() - cached.checkedAt < ttl) return cached.latest;
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
    if (compareSemverDesc(VERSION, latest) <= 0) return "quiet";
    const line = notice(latest, deps.execPath());
    deps.write(before ? `${line}\n` : `\n${line}`);
    return "announced";
  } catch {
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
