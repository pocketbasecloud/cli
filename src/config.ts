import { basename, dirname, join } from "@std/path";
import type { ResourceKind } from "./clients/types.ts";

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

export function readEnv(
  get: (key: string) => string | undefined,
  suffix: string,
): string | undefined {
  return pickEnv(get, suffix)?.value;
}

export function envVar(
  suffix: string,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string | undefined {
  return readEnv((key) => env[key], suffix);
}

export function envVarName(
  suffix: string,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string | undefined {
  return pickEnv((key) => env[key], suffix)?.name;
}

function envUrl(suffix: string, fallback: string): string {
  return envVar(suffix) || fallback;
}
export function backendUrl(): string {
  return envUrl("BACKEND_URL", "https://backend.pocketbasecloud.com");
}
export function backendExtUrl(): string {
  return envUrl("EXT_URL", "https://backend-ext.pocketbasecloud.com");
}
export function portalUrl(): string {
  return envUrl("PORTAL_URL", "https://portal.pocketbasecloud.com/login");
}

export type CloudAuth = {
  backendUrl: string;
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
export type EnvEntry = {
  id: string;
  name: string;
  build?: BuildConfig;
};
export type BuildConfig = {
  command?: string;
  install?: string;
  outputDir?: string;
  runtime?: "deno" | "bun" | "nodejs" | "nextjs";
  startCommand?: string;
  exclude?: string[];
  envFile?: string;
  pbPublic?: string;
  pbHooks?: string;
  pbMigrations?: string;
};

export type LinkFile = {
  projectId: string;
  pocketbaseVersion?: string;
  kind?: ResourceKind;
  build?: BuildConfig;
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

export function configPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(configBase(env), "pbc", "config.json");
}

export function legacyConfigPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(configBase(env), "pb", "config.json");
}

export function updateCheckPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(dirname(configPath(env)), "update-check.json");
}

export async function loadConfig(): Promise<Config> {
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
  await Deno.chmod(path, 0o600).catch(() => {});
}

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

export const LINK_FILE = "pbc.json";
export const LEGACY_LINK_FILE = "pb.json";
const LINK_FILES = [LINK_FILE, LEGACY_LINK_FILE] as const;

export async function linkFilePath(cwd: string): Promise<string> {
  for (const name of LINK_FILES) {
    const path = join(cwd, name);
    try {
      if ((await Deno.stat(path)).isFile) return path;
    } catch { /* try the next name */ }
  }
  return join(cwd, LINK_FILE);
}

export async function linkFileName(cwd: string): Promise<string> {
  return basename(await linkFilePath(cwd));
}

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
        if (parsed.projectId) return parsed as LinkFile;
        return null;
      } catch { /* try the next name, then keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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

export type RemoveEnvResult = {
  removed: boolean;
  repointedTo?: string;
  defaultDropped?: boolean;
  emptied?: boolean;
};

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

export async function upsertBuildConfig(
  cwd: string,
  build: BuildConfig,
): Promise<void> {
  const existing = await readOwnLinkFile(cwd);
  await writeLinkFile(cwd, { ...existing, build });
}

export async function setDefaultEnvironment(
  cwd: string,
  environment: string,
): Promise<void> {
  const existing = await readOwnLinkFile(cwd);
  await writeLinkFile(cwd, { ...existing, defaultEnvironment: environment });
}
