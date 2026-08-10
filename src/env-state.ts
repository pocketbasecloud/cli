import { dirname, join } from "@std/path";
import { configPath } from "./config.ts";
import { sha256Hex } from "./hash.ts";

/**
 * Where a deploy remembers the env vars it last pushed, so the next one can
 * tell "the file changed" from "the file is the same" and skip a write that
 * would change nothing.
 *
 * Kept beside the config rather than in pb.json for two reasons: the digest is
 * derived from secret values and pb.json is committed to git, and this is a
 * cache — a missing or unreadable file costs one redundant push, never
 * correctness. Every failure mode here therefore falls open towards pushing.
 */
export function envStatePath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(dirname(configPath(env)), "env-state.json");
}

/** One remembered push. `at` exists only so old entries can be aged out. */
type Entry = { digest: string; at: string };
type EnvState = { targets: Record<string, Entry> };

/** How long an entry survives without being rewritten. */
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Identity of one cloud env store: the resource it belongs to, not the file it
 * came from. Renaming `.env.prod` to `.env.production` pushes the same values
 * to the same instance, and re-uploading them is exactly what this avoids.
 */
export function envStateKey(
  type: "pocketbase" | "backend",
  targetId: string,
): string {
  return `${type}:${targetId}`;
}

/**
 * Fingerprint of a push: the variables that would be written, plus whether
 * cloud-only keys are being pruned.
 *
 * It hashes the *parsed* map, so reordering keys, editing a comment or
 * reflowing whitespace is not a change — only the values the platform would
 * end up storing are. `prune` is part of it because the same file pushed with
 * `--delete-missing` does something a merge did not, and a run that adds the
 * flag must not be mistaken for a repeat of the run without it.
 */
export async function envDigest(
  vars: Record<string, string>,
  prune: boolean,
): Promise<string> {
  const body = Object.keys(vars).sort()
    .map((k) => `${k}=${vars[k]}`)
    .join("\n");
  // The version prefix lets a later change to this encoding invalidate every
  // stored digest instead of silently matching one computed the old way.
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
    // Absent, unreadable or corrupt all mean the same thing: nothing is known
    // about this target, so the caller pushes.
    return { targets: {} };
  }
}

async function writeState(path: string, state: EnvState): Promise<void> {
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(state, null, 2));
    await Deno.chmod(path, 0o600).catch(() => {}); // no-op on Windows
  } catch {
    // A read-only HOME must not fail a deploy whose work already succeeded;
    // the only cost is that the next deploy pushes again.
  }
}

/** Drop entries for resources nobody has deployed in a long time. */
function prune(targets: Record<string, Entry>, now: number): void {
  for (const [key, entry] of Object.entries(targets)) {
    const at = Date.parse(entry?.at ?? "");
    if (Number.isNaN(at) || now - at > MAX_AGE_MS) delete targets[key];
  }
}

/** The digest of the last push to this target, if one was ever recorded. */
export async function lastEnvDigest(
  key: string,
  path = envStatePath(),
): Promise<string | undefined> {
  const entry = (await readState(path)).targets[key];
  return typeof entry?.digest === "string" ? entry.digest : undefined;
}

/** Remember what a target's env store now holds. */
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

/**
 * Forget a target, so the next deploy pushes whatever it has.
 *
 * Called whenever the cloud store is written by something other than a deploy
 * — `env set`, `env rm` — because a remembered digest that no longer describes
 * the cloud is the one way this cache could skip a push that mattered.
 */
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
