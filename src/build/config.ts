import type { BuildConfig, LinkFile } from "../config.ts";
import { linkFileName, readOwnLinkFile, upsertBuildConfig } from "../config.ts";
import type { ResourceKind } from "../clients/types.ts";
import { describeBuild, detectPythonVersion, inferBuild } from "./detect.ts";
import { UnsupportedPythonError } from "./python-detect.ts";
import { CliError } from "../errors.ts";

export type BuildFlags = {
  runtime?: string;
  pythonVersion?: string;
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
  const pythonVersion = flags.pythonVersion ?? build.pythonVersion ??
    (runtime === "python" ? await detectedPythonVersion(cwd, log) : undefined);
  return {
    ...build,
    ...(runtime ? { runtime: runtime as BuildConfig["runtime"] } : {}),
    ...(pythonVersion ? { pythonVersion } : {}),
    ...(flags.envFile ? { envFile: flags.envFile } : {}),
  };
}

async function detectedPythonVersion(
  cwd: string,
  log: (msg: string) => void,
): Promise<string> {
  try {
    const version = await detectPythonVersion(cwd);
    log(`Python ${version}`);
    return version;
  } catch (error) {
    if (error instanceof UnsupportedPythonError) {
      throw new CliError(error.message, { code: "INVALID_VALUE" });
    }
    throw error;
  }
}

export function envFileOf(build: BuildConfig): string | undefined {
  return build.envFile;
}
