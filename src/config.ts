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
/** The single cloud resource a directory's pb.json is bound to (1:1). */
export type ResourceLink = {
  kind: ResourceKind;
  id: string;
  name: string;
};
export type LinkFile = {
  projectId: string;
  pocketbaseVersion?: string;
  resource?: ResourceLink;
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
async function readOwnPbJson(cwd: string): Promise<Partial<LinkFile>> {
  try {
    return JSON.parse(await Deno.readTextFile(join(cwd, "pb.json")));
  } catch {
    return {};
  }
}

/**
 * Record the cloud resource this directory deploys to. Writes to the cwd's own
 * pb.json (creating it, self-contained, if absent), preserving other fields.
 *
 * `projectId` always names the project the bound resource lives in — the two
 * must agree, or a later flagless command would look the resource up in the
 * wrong project. It therefore overwrites any `projectId` already in the file,
 * which only differs when the caller passed an explicit `--project`.
 */
export async function upsertResourceLink(
  cwd: string,
  projectId: string,
  resource: ResourceLink,
): Promise<void> {
  const existing = await readOwnPbJson(cwd);
  const next: LinkFile = {
    ...existing,
    projectId,
    resource,
  };
  await Deno.writeTextFile(
    join(cwd, "pb.json"),
    JSON.stringify(next, null, 2) + "\n",
  );
}

/**
 * The resource bound to the cwd's *own* pb.json. Unlike `readLinkFile` this
 * never walks up, so `pb cloud unlink` cannot detach a parent directory.
 */
export async function readOwnResourceLink(
  cwd: string,
): Promise<ResourceLink | null> {
  return (await readOwnPbJson(cwd)).resource ?? null;
}

/** Remove the resource binding from the cwd's pb.json, leaving the rest intact. */
export async function clearResourceLink(cwd: string): Promise<void> {
  const existing = await readOwnPbJson(cwd);
  if (!existing.resource) return;
  delete existing.resource;
  await Deno.writeTextFile(
    join(cwd, "pb.json"),
    JSON.stringify(existing, null, 2) + "\n",
  );
}
