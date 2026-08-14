import { dirname, join } from "@std/path";
import type { ResourceKind } from "./clients/types.ts";

/**
 * The platform's hosts are fixed, not configurable. `PB_TOKEN` still selects
 * *who* the CLI acts as, but nothing selects *where* it sends that token —
 * an overridable backend URL is a way to hand a user's credentials to a host
 * the platform does not control.
 */
function envUrl(key: string, fallback: string): string {
  return Deno.env.get(key) || fallback;
}
/** e2e smoke tests override these — not a user-facing feature. */
export function backendUrl(): string {
  return envUrl("PB_BACKEND_URL", "https://backend.pocketbasecloud.com");
}
/**
 * backend-extension is a separate service from PocketBase, on its own host. It
 * serves the deploy-side routes PocketBase has none of — logs, custom domains,
 * bulk env, export — and the CLI calls it directly with the user's token.
 */
export function backendExtUrl(): string {
  return envUrl("PB_EXT_URL", "https://backend-ext.pocketbasecloud.com");
}
/**
 * Pinned for the same reason as the backends, and specifically *with* them: the
 * portal is where the browser login mints the token, so a portal on one
 * environment and a backend on another hands the CLI a token its backend will
 * never accept — an unbreakable "log in again" loop.
 */
export function portalUrl(): string {
  return envUrl("PB_PORTAL_URL", "https://portal.pocketbasecloud.com/login");
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
 * A directory's pb.json: fields shared by every environment, plus the per
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

export function configPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const home = env["HOME"] ?? env["USERPROFILE"] ?? ".";
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".config");
  return join(base, "pb", "config.json");
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
  try {
    const text = await Deno.readTextFile(configPath());
    return fillInHosts({ ...defaultConfig(), ...JSON.parse(text) });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return defaultConfig();
    throw e;
  }
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

/** True when `PB_TOKEN` is shadowing whatever login is saved on disk. */
export function usesEnvToken(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): boolean {
  return Boolean(env["PB_TOKEN"]);
}

/**
 * Who the CLI is acting as. `PB_TOKEN` wins over the saved login so CI can
 * authenticate without a browser; the hosts are not part of that choice, and
 * are stamped from the constants above whichever way the token arrives —
 * including over whatever an older config wrote to disk.
 *
 * Because the env token wins silently, `login`/`logout` call {@link usesEnvToken}
 * to warn when their work is about to be overridden by it.
 */
export function resolveCloudAuth(
  c: Config,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): CloudAuth | null {
  const hosts = { backendUrl: backendUrl(), extUrl: backendExtUrl() };
  const token = env["PB_TOKEN"];
  if (token) return { ...hosts, userToken: token, userId: "" };
  if (!c.cloud) return null;
  return { ...c.cloud, ...hosts };
}

export async function readLinkFile(cwd: string): Promise<LinkFile | null> {
  let dir = cwd;
  while (true) {
    try {
      const text = await Deno.readTextFile(join(dir, "pb.json"));
      const parsed = JSON.parse(text) as Partial<LinkFile>;
      // A pb.json that does not identify a project is not a link — `pb init`
      // writes one containing only a version pin.
      if (parsed.projectId) return parsed as LinkFile;
      return null;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read the cwd's own pb.json (no walk-up), tolerating an absent/invalid file. */
export async function readOwnPbJson(cwd: string): Promise<Partial<LinkFile>> {
  try {
    return JSON.parse(await Deno.readTextFile(join(cwd, "pb.json")));
  } catch {
    return {};
  }
}

async function writePbJson(
  cwd: string,
  file: Partial<LinkFile>,
): Promise<void> {
  await Deno.writeTextFile(
    join(cwd, "pb.json"),
    JSON.stringify(file, null, 2) + "\n",
  );
}

/**
 * Record the cloud resource one environment of this directory deploys to.
 * Writes to the cwd's own pb.json (creating it, self-contained, if absent),
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
  const existing = await readOwnPbJson(cwd);
  const environments = { ...existing.environments };
  const prev = environments[opts.environment];
  environments[opts.environment] = {
    ...prev,
    ...opts.entry,
    ...(prev?.build || opts.entry.build
      ? { build: { ...prev?.build, ...opts.entry.build } }
      : {}),
  };
  await writePbJson(cwd, {
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
 * Forget one environment of the cwd's *own* pb.json. Unlike `readLinkFile` this
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
  const existing = await readOwnPbJson(cwd);
  const environments = { ...existing.environments };
  if (!(environment in environments)) return { removed: false };
  delete environments[environment];

  const next: Partial<LinkFile> = { ...existing };
  const remaining = Object.keys(environments);
  if (remaining.length === 0) {
    delete next.environments;
    delete next.defaultEnvironment;
    delete next.kind;
    await writePbJson(cwd, next);
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
  await writePbJson(cwd, next);
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
  const existing = await readOwnPbJson(cwd);
  if (existing.environments?.[environment]?.id !== id) {
    return { removed: false };
  }
  return await removeEnvironment(cwd, environment);
}

/** Forget every environment, leaving `projectId` and `build` intact. */
export async function clearEnvironments(cwd: string): Promise<string[]> {
  const existing = await readOwnPbJson(cwd);
  const names = Object.keys(existing.environments ?? {});
  if (names.length === 0) return [];
  delete existing.environments;
  delete existing.defaultEnvironment;
  delete existing.kind;
  await writePbJson(cwd, existing);
  return names;
}

/**
 * Record an inferred build config in the cwd's pb.json so the next deploy is
 * deterministic and the choice is reviewable in git. Never called when the
 * file already carries a `build` block.
 */
export async function upsertBuildConfig(
  cwd: string,
  build: BuildConfig,
): Promise<void> {
  const existing = await readOwnPbJson(cwd);
  await writePbJson(cwd, { ...existing, build });
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
  const existing = await readOwnPbJson(cwd);
  await writePbJson(cwd, { ...existing, defaultEnvironment: environment });
}
