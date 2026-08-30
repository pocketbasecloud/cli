import { dirname, join } from "@std/path";
import { configPath } from "./config.ts";
import { sha256Hex } from "./hash.ts";

export function envStatePath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(dirname(configPath(env)), "env-state.json");
}

type Entry = { digest: string; at: string };
type EnvState = { targets: Record<string, Entry> };

const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export function envStateKey(
  type: "pocketbase" | "backend",
  targetId: string,
): string {
  return `${type}:${targetId}`;
}

export async function envDigest(
  vars: Record<string, string>,
  prune: boolean,
): Promise<string> {
  const body = Object.keys(vars).sort()
    .map((k) => `${k}=${vars[k]}`)
    .join("\n");
  return await sha256Hex(
    new TextEncoder().encode(`v1\nprune=${prune}\n${body}`),
  );
}

async function readState(path: string): Promise<EnvState> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as Partial<
      EnvState
    >;
    const targets = parsed?.targets;
    if (!targets || typeof targets !== "object") return { targets: {} };
    return { targets };
  } catch {
    return { targets: {} };
  }
}

async function writeState(path: string, state: EnvState): Promise<void> {
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(state, null, 2));
    await Deno.chmod(path, 0o600).catch(() => {});
  } catch {
    // A read-only HOME must not fail a deploy whose work already succeeded;
    // the only cost is that the next deploy pushes again.
  }
}

function prune(targets: Record<string, Entry>, now: number): void {
  for (const [key, entry] of Object.entries(targets)) {
    const at = Date.parse(entry?.at ?? "");
    if (Number.isNaN(at) || now - at > MAX_AGE_MS) delete targets[key];
  }
}

export async function lastEnvDigest(
  key: string,
  path = envStatePath(),
): Promise<string | undefined> {
  const entry = (await readState(path)).targets[key];
  return typeof entry?.digest === "string" ? entry.digest : undefined;
}

export async function recordEnvDigest(
  key: string,
  digest: string,
  path = envStatePath(),
): Promise<void> {
  const state = await readState(path);
  const now = Date.now();
  prune(state.targets, now);
  state.targets[key] = { digest, at: new Date(now).toISOString() };
  await writeState(path, state);
}

export async function forgetEnvDigest(
  key: string,
  path = envStatePath(),
): Promise<void> {
  const state = await readState(path);
  if (!(key in state.targets)) return;
  delete state.targets[key];
  prune(state.targets, Date.now());
  await writeState(path, state);
}
