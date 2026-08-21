import { basename, dirname, join } from "@std/path";
import type { ResourceKind } from "./clients/types.ts";

/**
 * The one place the `PBC_` → `PB_` precedence lives: current spelling first,
 * the pre-0.6.0 one second, and empty counting as unset on both — which is how
 * a CI job has always said "no token", so `PBC_TOKEN=""` still falls through.
 *
 * Returns the name as well as the value because a message that asks the user
 * to change a variable has to name the one they actually set. Deriving both
 * from a single walk is what stops the value and the name disagreeing about
 * which spelling won.
 *
 * Takes a getter rather than an object so the same precedence serves callers
 * holding a `Deno.env`-shaped record and callers holding an injected `env()`.
 */
function pickEnv(
  get: (key: string) => string | undefined,
  suffix: string,
): { name: string; value: string } | undefined {
  for (const name of [`PBC_${suffix}`, `PB_${suffix}`]) {
    const value = get(name);
    if (value !== undefined && value !== "") return { name, value };
  }
  return undefined;
}

/** {@link pickEnv}'s value, for a caller holding an injected `env()`. */
export function readEnv(
  get: (key: string) => string | undefined,
  suffix: string,
): string | undefined {
  return pickEnv(get, suffix)?.value;
}

/** {@link readEnv} against a plain record, which is how most callers hold env. */
export function envVar(
  suffix: string,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string | undefined {
  return readEnv((key) => env[key], suffix);
}

/**
 * Which spelling actually supplied the value. Telling someone to unset
 * `PBC_TOKEN` when their shell exports `PB_TOKEN` sends them looking for a
 * variable that is not there.
 */
export function envVarName(
  suffix: string,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string | undefined {
  return pickEnv((key) => env[key], suffix)?.name;
}

/**
 * The platform's hosts are fixed, not configurable. `PBC_TOKEN` still selects
 * *who* the CLI acts as, but nothing selects *where* it sends that token —
 * an overridable backend URL is a way to hand a user's credentials to a host
 * the platform does not control.
 */
function envUrl(suffix: string, fallback: string): string {
  return envVar(suffix) || fallback;
}
/** e2e smoke tests override these — not a user-facing feature. */
export function backendUrl(): string {
  return envUrl("BACKEND_URL", "https://backend.pocketbasecloud.com");
}
/**
 * backend-extension is a separate service from PocketBase, on its own host. It
 * serves the deploy-side routes PocketBase has none of — logs, custom domains,
 * bulk env, export — and the CLI calls it directly with the user's token.
 */
export function backendExtUrl(): string {
  return envUrl("EXT_URL", "https://backend-ext.pocketbasecloud.com");
}
/**
 * Pinned for the same reason as the backends, and specifically *with* them: the
 * portal is where the browser login mints the token, so a portal on one
 * environment and a backend on another hands the CLI a token its backend will
 * never accept — an unbreakable "log in again" loop.
 */
export function portalUrl(): string {
  return envUrl("PORTAL_URL", "https://portal.pocketbasecloud.com/login");
}

export type CloudAuth = {
  /**
   * Always the production backend in practice — `resolveCloudAuth` stamps it,
   * and a stored or inherited value never survives. It stays on the type so
   * tests can point a client at a stub host.
   */
  backendUrl: string;
  /**
   * backend-extension base URL; likewise always the production host.
   * Required, not optional: a client left to fall back to the production host
   * would send a stub host's token there.
   */
  extUrl: string;
  userToken: string;
  userId: string;
};
export type Profile = { url: string; superuserToken: string };
export type Config = {
  cloud: CloudAuth | null;
  currentProject: string | null;
  defaultProfile: string | null;
  profiles: Record<string, Profile>;
};
/**
 * One deployment target of a directory: the cloud resource a named environment
 * points at, plus whatever that environment builds differently. The resource's
 * `kind` is not here — it lives on the file, shared by every environment,
 * because a directory is one kind forever.
 */
export type EnvEntry = {
  id: string;
  name: string;
  /** Overrides merged over the file's base `build`, key by key. */
  build?: BuildConfig;
};
/**
 * How a directory turns into a deployable zip. The file's base block applies to
 * every environment; an environment may override any subset of it. Fields that
 * do not apply to the bound kind are ignored rather than rejected.
 */
export type BuildConfig = {
  /** Shell command run in the resource directory. Omit for no build step. */
  command?: string;
  /**
   * How dependencies get installed when the build needs some that are not
   * there. Unset infers it from the lockfile (`pnpm install`, `npm install`, …)
   * and runs it at the workspace root; an empty string disables the step for
   * projects that install their own way. Never runs when nothing is missing,
   * and never without a `command` to build.
   */
  install?: string;
  /** Directory whose contents become the zip root. */
  outputDir?: string;
  /** Backends only. Mirrors --runtime; selects the packaging strategy. */
  runtime?: "deno" | "bun" | "nodejs" | "nextjs";
  /**
   * Backends only. Mirrors --start; the command the platform runs to boot the
   * container. Inferred from the project's own start task/script, because a
   * backend that ships source cannot start without one.
   */
  startCommand?: string;
  /** Extra exclude globs, on top of the built-in denylist. */
  exclude?: string[];
  /**
   * Which dotenv file a deploy pushes to the cloud env store. Unset means the
   * question has not been answered for this environment yet — deploy asks once
   * and records the answer here. An empty string is that answer meaning "none",
   * which is why it is not the same as unset. See `envFileOf`.
   */
  envFile?: string;
  /** PocketBase only. Paths relative to the resource directory. */
  pbPublic?: string;
  pbHooks?: string;
  pbMigrations?: string;
};

/**
 * A directory's link file: fields shared by every environment, plus the per
 * environment deltas. `projectId` is deliberately not overridable — every
 * environment of a directory lives in the same cloud project.
 */
export type LinkFile = {
  projectId: string;
  pocketbaseVersion?: string;
  /** The kind every environment of this directory deploys. */
  kind?: ResourceKind;
  build?: BuildConfig;
  /** Which environment a command targets when none is named. */
  defaultEnvironment?: string;
  environments?: Record<string, EnvEntry>;
};

export function defaultConfig(): Config {
  return {
    cloud: null,
    currentProject: null,
    defaultProfile: null,
    profiles: {},
  };
}

function configBase(env: Record<string, string | undefined>): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const home = env["HOME"] ?? env["USERPROFILE"] ?? ".";
  return xdg && xdg.length > 0 ? xdg : join(home, ".config");
}

/** Where the CLI keeps the saved login. Everything writes here. */
export function configPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(configBase(env), "pbc", "config.json");
}

/**
 * The pre-0.6.0 location, read when {@link configPath} holds nothing. Left in
 * place rather than moved: the first save writes the new file and the old one
 * stops being consulted, but a `pb` binary from before the rename keeps its own
 * login working.
 */
export function legacyConfigPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(configBase(env), "pb", "config.json");
}

/**
 * Where the background update check remembers its last look. Kept beside the
 * config rather than inside it: it is a cache, and losing it costs one request.
 */
export function updateCheckPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(dirname(configPath(env)), "update-check.json");
}

export async function loadConfig(): Promise<Config> {
  // Only absence falls through to the older location — malformed JSON is still
  // an error, so a corrupt config surfaces instead of silently reverting to a
  // login the user replaced.
  for (const path of [configPath(), legacyConfigPath()]) {
    try {
      const text = await Deno.readTextFile(path);
      return fillInHosts({ ...defaultConfig(), ...JSON.parse(text) });
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  return defaultConfig();
}

/**
 * Stamp hosts onto a login written by a CLI old enough not to have had a field
 * for them. Normalising here, at the one boundary raw JSON enters, is what lets
 * {@link CloudAuth.extUrl} stay non-optional — and a non-optional extUrl is
 * what stops a caller quietly defaulting a stub host to production.
 */
function fillInHosts(c: Config): Config {
  if (c.cloud && !c.cloud.extUrl) {
    c.cloud = { ...c.cloud, extUrl: backendExtUrl() };
  }
  return c;
}

export async function saveConfig(c: Config): Promise<void> {
  const path = configPath();
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(c, null, 2));
  await Deno.chmod(path, 0o600).catch(() => {}); // no-op on Windows
}

/**
 * Who the CLI is acting as. `PBC_TOKEN` wins over the saved login so CI can
 * authenticate without a browser; the hosts are not part of that choice, and
 * are stamped from the constants above whichever way the token arrives —
 * including over whatever an older config wrote to disk.
 *
 * Because the env token wins silently, `login`/`logout` call {@link envVarName}
 * to warn — by the name that is actually set — when their work is about to be
 * overridden by it.
 */
export function resolveCloudAuth(
  c: Config,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): CloudAuth | null {
  const hosts = { backendUrl: backendUrl(), extUrl: backendExtUrl() };
  const token = envVar("TOKEN", env);
  if (token) return { ...hosts, userToken: token, userId: "" };
  if (!c.cloud) return null;
  return { ...c.cloud, ...hosts };
}

/** The link file a directory is read from, newest name first. */
export const LINK_FILE = "pbc.json";
/** What it was called before 0.6.0. Still read, and still written to when it
 * is the file a directory already has. */
export const LEGACY_LINK_FILE = "pb.json";
const LINK_FILES = [LINK_FILE, LEGACY_LINK_FILE] as const;

/**
 * Which link file this directory writes to: whichever one it already has,
 * `pbc.json` when it has neither.
 *
 * Writing back to the file that is there is the whole compatibility story for
 * committed repositories — a checkout holding `pb.json` keeps one link file
 * rather than growing a second one that only the newer CLI can see, and its
 * diffs stay about the binding rather than about the rename.
 */
export async function linkFilePath(cwd: string): Promise<string> {
  for (const name of LINK_FILES) {
    const path = join(cwd, name);
    try {
      if ((await Deno.stat(path)).isFile) return path;
    } catch { /* try the next name */ }
  }
  return join(cwd, LINK_FILE);
}

/**
 * Just the name of that file, for messages about what this directory writes. A
 * directory still on `pb.json` must be pointed at `pb.json` — naming the file
 * it does not have is worse than not naming one at all.
 */
export async function linkFileName(cwd: string): Promise<string> {
  return basename(await linkFilePath(cwd));
}

/**
 * The name of the file that *binds* `cwd`, which {@link readLinkFile} may have
 * found in a parent. Messages about a binding have to walk the same way it did:
 * in a monorepo whose root holds the link file, naming `cwd`'s own would name a
 * file that exists nowhere.
 */
export async function bindingFileName(cwd: string): Promise<string> {
  let dir = cwd;
  while (true) {
    for (const name of LINK_FILES) {
      try {
        if ((await Deno.stat(join(dir, name))).isFile) return name;
      } catch { /* try the next name, then keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return LINK_FILE;
    dir = parent;
  }
}

export async function readLinkFile(cwd: string): Promise<LinkFile | null> {
  let dir = cwd;
  while (true) {
    for (const name of LINK_FILES) {
      try {
        const text = await Deno.readTextFile(join(dir, name));
        const parsed = JSON.parse(text) as Partial<LinkFile>;
        // A link file that does not identify a project is not a link —
        // `pbc init` writes one containing only a version pin.
        if (parsed.projectId) return parsed as LinkFile;
        return null;
      } catch { /* try the next name, then keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read the cwd's own link file (no walk-up), tolerating an absent or invalid
 * one.
 */
export async function readOwnLinkFile(cwd: string): Promise<Partial<LinkFile>> {
  for (const name of LINK_FILES) {
    try {
      return JSON.parse(await Deno.readTextFile(join(cwd, name)));
    } catch { /* try the next name */ }
  }
  return {};
}

async function writeLinkFile(
  cwd: string,
  file: Partial<LinkFile>,
): Promise<void> {
  await Deno.writeTextFile(
    await linkFilePath(cwd),
    JSON.stringify(file, null, 2) + "\n",
  );
}

/**
 * Record the cloud resource one environment of this directory deploys to.
 * Writes to the cwd's own link file (creating it, self-contained, if absent),
 * preserving other fields and the environment's own build overrides.
 *
 * `projectId` always names the project the bound resources live in — the two
 * must agree, or a later flagless command would look the resource up in the
 * wrong project. It therefore overwrites any `projectId` already in the file,
 * which only differs when the caller passed an explicit `--project`.
 *
 * `kind` and `defaultEnvironment` are filled in on the way through: the first
 * environment recorded becomes the default, and later ones leave it alone.
 *
 * `entry.build` merges a key at a time rather than replacing the block: a
 * caller recording one field (deploy records `envFile`) must not drop the
 * environment's other overrides, which it never had in hand to begin with.
 */
export async function upsertEnvironment(
  cwd: string,
  opts: {
    projectId: string;
    kind: ResourceKind;
    environment: string;
    entry: EnvEntry;
  },
): Promise<void> {
  const existing = await readOwnLinkFile(cwd);
  const environments = { ...existing.environments };
  const prev = environments[opts.environment];
  environments[opts.environment] = {
    ...prev,
    ...opts.entry,
    ...(prev?.build || opts.entry.build
      ? { build: { ...prev?.build, ...opts.entry.build } }
      : {}),
  };
  await writeLinkFile(cwd, {
    ...existing,
    projectId: opts.projectId,
    kind: opts.kind,
    defaultEnvironment: existing.defaultEnvironment ?? opts.environment,
    environments,
  });
}

/** What `removeEnvironment` had to do beyond dropping the entry. */
export type RemoveEnvResult = {
  /** False when the environment was not in the file to begin with. */
  removed: boolean;
  /** Set when the removed environment was the default and one other remained. */
  repointedTo?: string;
  /** True when the default was removed and several candidates remained. */
  defaultDropped?: boolean;
  /** True when that was the last environment, so `kind` went with it. */
  emptied?: boolean;
};

/**
 * Forget one environment of the cwd's *own* link file. Unlike `readLinkFile` this
 * never walks up, so `rm` and `unlink` cannot detach a parent directory.
 *
 * Removing the default leaves the file without one rather than silently
 * promoting an arbitrary survivor: the next bare deploy then asks for `--env`
 * instead of guessing which environment inherited production's role.
 */
export async function removeEnvironment(
  cwd: string,
  environment: string,
): Promise<RemoveEnvResult> {
  const existing = await readOwnLinkFile(cwd);
  const environments = { ...existing.environments };
  if (!(environment in environments)) return { removed: false };
  delete environments[environment];

  const next: Partial<LinkFile> = { ...existing };
  const remaining = Object.keys(environments);
  if (remaining.length === 0) {
    delete next.environments;
    delete next.defaultEnvironment;
    delete next.kind;
    await writeLinkFile(cwd, next);
    return { removed: true, emptied: true };
  }

  next.environments = environments;
  const result: RemoveEnvResult = { removed: true };
  if (existing.defaultEnvironment === environment) {
    if (remaining.length === 1) {
      next.defaultEnvironment = remaining[0];
      result.repointedTo = remaining[0];
    } else {
      delete next.defaultEnvironment;
      result.defaultDropped = true;
    }
  }
  await writeLinkFile(cwd, next);
  return result;
}

/**
 * Drop `environment` only when it is the one pointing at `id`. `rm --name
 * something-else` resolves a resource the file may not track, and must not
 * detach an environment bound to a different one.
 */
export async function removeEnvironmentFor(
  cwd: string,
  environment: string,
  id: string,
): Promise<RemoveEnvResult> {
  const existing = await readOwnLinkFile(cwd);
  if (existing.environments?.[environment]?.id !== id) {
    return { removed: false };
  }
  return await removeEnvironment(cwd, environment);
}

/** Forget every environment, leaving `projectId` and `build` intact. */
export async function clearEnvironments(cwd: string): Promise<string[]> {
  const existing = await readOwnLinkFile(cwd);
  const names = Object.keys(existing.environments ?? {});
  if (names.length === 0) return [];
  delete existing.environments;
  delete existing.defaultEnvironment;
  delete existing.kind;
  await writeLinkFile(cwd, existing);
  return names;
}

/**
 * Record an inferred build config in the cwd's link file so the next deploy is
 * deterministic and the choice is reviewable in git. Never called when the
 * file already carries a `build` block.
 */
export async function upsertBuildConfig(
  cwd: string,
  build: BuildConfig,
): Promise<void> {
  const existing = await readOwnLinkFile(cwd);
  await writeLinkFile(cwd, { ...existing, build });
}

/**
 * Record which environment this directory deploys to by default, before any
 * resource is bound to it. `upsertEnvironment` sets the same field when it
 * writes the first entry; this is for `init`, which sets up the file without
 * touching the cloud.
 */
export async function setDefaultEnvironment(
  cwd: string,
  environment: string,
): Promise<void> {
  const existing = await readOwnLinkFile(cwd);
  await writeLinkFile(cwd, { ...existing, defaultEnvironment: environment });
}
