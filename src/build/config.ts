import type { BuildConfig, LinkFile } from "../config.ts";
import { linkFileName, readOwnLinkFile, upsertBuildConfig } from "../config.ts";
import type { ResourceKind } from "../clients/types.ts";
import { describeBuild, inferBuild } from "./detect.ts";

export type BuildFlags = {
  runtime?: string;
  envFile?: string;
};

export function mergeEnvBuild(
  file: Partial<LinkFile>,
  environment?: string,
): BuildConfig {
  const override = environment
    ? file.environments?.[environment]?.build
    : undefined;
  return { ...file.build, ...override };
}

export async function resolveBuildConfig(opts: {
  cwd: string;
  kind: ResourceKind;
  flags: BuildFlags;
  environment?: string;
  log: (msg: string) => void;
}): Promise<BuildConfig> {
  const { cwd, kind, flags, environment, log } = opts;
  const own = await readOwnLinkFile(cwd);

  if (!own.build && !own.environments?.[environment ?? ""]?.build) {
    const inferred = await inferBuild(cwd, kind);
    const name = await linkFileName(cwd);
    log(`No "build" block in ${name} — inferred from ${cwd}:`);
    for (const line of describeBuild(inferred)) log(line);
    await upsertBuildConfig(cwd, inferred);
    log(`Recorded it in ${name}.`);
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

export function envFileOf(build: BuildConfig): string | undefined {
  return build.envFile;
}
