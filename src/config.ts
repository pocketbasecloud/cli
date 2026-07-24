import { dirname, join } from "@std/path";

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
export type LinkFile = {
  projectId: string;
  backendUrl: string;
  pocketbaseVersion?: string;
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

export async function writeLinkFile(
  cwd: string,
  link: LinkFile,
): Promise<void> {
  await Deno.writeTextFile(
    join(cwd, "pb.json"),
    JSON.stringify(link, null, 2) + "\n",
  );
}
