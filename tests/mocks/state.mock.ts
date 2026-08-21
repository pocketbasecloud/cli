import { join } from "@std/path";

/**
 * A throwaway path for the env-push digests a deploy records, wired in as
 * `CloudCmdDeps.envStatePath`.
 *
 * Without it a test would read and write `~/.config/pbc/env-state.json`, and the
 * mock client's ids repeat from run to run — so a second run would find its own
 * first run's digest and skip the very push the test asserts.
 */
export function tempStatePath(): () => string {
  const path = join(Deno.makeTempDirSync(), "env-state.json");
  return () => path;
}
