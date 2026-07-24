import { dirname, join } from "@std/path";
import type { ResourceKind } from "./clients/types.ts";

export type CloudAuth = {
  backendUrl: string;
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
  /** Directory whose contents become the zip root. */
  outputDir?: string;
  /** Backends only. Mirrors --runtime; selects the packaging strategy. */
  runtime?: "deno" | "bun" | "nodejs" | "nextjs";
  /** Extra exclude globs, on top of the built-in denylist. */
  exclude?: string[];
  /** Which dotenv file --push-env reads. Defaults to ".env". */
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

export async function loadConfig(): Promise<Config> {
  try {
    const text = await Deno.readTextFile(configPath());
    return { ...defaultConfig(), ...JSON.parse(text) };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return defaultConfig();
    throw e;
  }
}

export async function saveConfig(c: Config): Promise<void> {
  const path = configPath();
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(c, null, 2));
  await Deno.chmod(path, 0o600).catch(() => {}); // no-op on Windows
}

export function resolveCloudAuth(
  c: Config,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): CloudAuth | null {
  const token = env["PB_TOKEN"];
  const url = env["PB_BACKEND_URL"];
  if (token && url) return { backendUrl: url, userToken: token, userId: "" };
  return c.cloud;
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
  environments[opts.environment] = {
    ...environments[opts.environment],
    ...opts.entry,
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
