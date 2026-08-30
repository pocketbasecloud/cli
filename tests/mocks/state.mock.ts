import { join } from "@std/path";

export function tempStatePath(): () => string {
  const path = join(Deno.makeTempDirSync(), "env-state.json");
  return () => path;
}
