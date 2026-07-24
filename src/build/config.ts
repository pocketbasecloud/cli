import type { BuildConfig, LinkFile } from "../config.ts";
import { readOwnPbJson, upsertBuildConfig } from "../config.ts";
import type { ResourceKind } from "../clients/types.ts";
import { describeBuild, inferBuild } from "./detect.ts";

/** Flag values that override the file, in the order the router parses them. */
export type BuildFlags = {
  runtime?: string;
  envFile?: string;
};

/**
 * The file's base `build` with one environment's overrides spread over it, key
 * by key. `exclude` is an array, so an environment that sets it replaces the
 * base list rather than appending — appending with no way to subtract is the
 * worse failure mode.
 */
export function mergeEnvBuild(
  file: Partial<LinkFile>,
  environment?: string,
): BuildConfig {
  const override = environment
    ? file.environments?.[environment]?.build
    : undefined;
  return { ...file.build, ...override };
}

/**
 * Resolves the build config for a deploy: flag > environment > base > inference.
 *
 * The `build` blocks are read from the cwd's *own* pb.json, never a parent's — a
 * parent directory's build command must not silently govern a child's deploy,
 * even though `readLinkFile` walks up to find the project binding.
 *
 * Inference runs only when there is no `build` block at all, base or
 * environment. A partial block is used as written: a user who removed `command`
 * on purpose does not get it back. An inferred block is persisted — to the base,
 * since inference reads the directory, which is the same in every environment —
 * so the next deploy is deterministic and the choice shows up in a diff.
 */
export async function resolveBuildConfig(opts: {
  cwd: string;
  kind: ResourceKind;
  flags: BuildFlags;
  environment?: string;
  log: (msg: string) => void;
}): Promise<BuildConfig> {
  const { cwd, kind, flags, environment, log } = opts;
  const own = await readOwnPbJson(cwd);

  if (!own.build && !own.environments?.[environment ?? ""]?.build) {
    const inferred = await inferBuild(cwd, kind);
    log(`No "build" block in pb.json — inferred from ${cwd}:`);
    for (const line of describeBuild(inferred)) log(line);
    await upsertBuildConfig(cwd, inferred);
    log(`Recorded it in pb.json.`);
    own.build = inferred;
  }

  const build = mergeEnvBuild(own, environment);
  const runtime = flags.runtime ?? build.runtime;
  return {
    ...build,
    ...(runtime ? { runtime: runtime as BuildConfig["runtime"] } : {}),
    ...(flags.envFile ? { envFile: flags.envFile } : {}),
  };
}

/** The dotenv file a `--push-env` reads. */
export function envFileOf(build: BuildConfig): string {
  return build.envFile ?? ".env";
}
