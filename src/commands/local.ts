import { basename, join } from "@std/path";
import type { CmdCtx, Handler } from "../router.ts";
import { CliError } from "../errors.ts";
import type { LocalDeps } from "../local/deps.ts";
import { installBinary, pinVersion, readPin } from "../local/install.ts";
import { scaffoldProject } from "../local/scaffold.ts";
import { listVersions } from "../local/releases.ts";
import { detectPlatform } from "../local/platform.ts";
import { createProgress, type Progress } from "../ui/progress.ts";

const NO_CHECKSUM_WARNING =
  "Warning: no checksums.txt for this release; skipped verification.";

function dirOf(deps: LocalDeps, ctx: CmdCtx): string {
  return (ctx.raw.dir as string | undefined) ?? deps.cwd();
}

/**
 * How to run the binary we just put in place. Prefixes a `cd` when it did not
 * land in the working directory, so the line is copy-pasteable either way.
 */
function startHint(deps: LocalDeps, dir: string, binPath: string): string {
  const run = `./${basename(binPath)} serve`;
  return dir === deps.cwd()
    ? `\nStart PocketBase with:\n  ${run}`
    : `\nStart PocketBase with:\n  cd ${dir} && ${run}`;
}

function installOptsFrom(deps: LocalDeps, ctx: CmdCtx) {
  return {
    version: ctx.args[0],
    dir: dirOf(deps, ctx),
    force: ctx.raw.force === true,
    os: ctx.raw.os as string | undefined,
    arch: ctx.raw.arch as string | undefined,
  };
}

export function makeLocalCommands(
  deps: LocalDeps,
  write: (s: string) => void = console.log,
  progress: Progress = createProgress(),
): Record<string, Handler> {
  /**
   * Downloading a PocketBase release, checksumming it and unzipping it takes
   * as long as the connection takes. Nothing is printed until it lands, so the
   * step carries the wait.
   */
  const download = (ctx: CmdCtx) =>
    progress.step(
      "Downloading PocketBase",
      () => installBinary(deps, installOptsFrom(deps, ctx)),
    );

  const install: Handler = async (ctx: CmdCtx) => {
    const dir = dirOf(deps, ctx);
    const res = await download(ctx);
    // Only pin what was actually installed — a skipped install leaves the
    // existing pin alone.
    if (!res.skipped) await pinVersion(deps, dir, res.version);

    if (ctx.flags.json) {
      write(JSON.stringify(res));
      return 0;
    }
    if (res.skipped) {
      write(`${res.path} already exists. Pass --force to re-download.`);
      write(startHint(deps, dir, res.path));
      return 0;
    }
    write(
      `Downloaded pocketbase ${res.version} (${res.os}/${res.arch}) → ${res.path}`,
    );
    if (!res.checksumVerified) console.error(NO_CHECKSUM_WARNING);
    write(startHint(deps, dir, res.path));
    return 0;
  };

  const init: Handler = async (ctx: CmdCtx) => {
    const dir = dirOf(deps, ctx);
    const res = await download(ctx);
    const scaffold = await scaffoldProject(deps, dir);
    if (!res.skipped) await pinVersion(deps, dir, res.version);

    if (ctx.flags.json) {
      write(JSON.stringify({ ...res, scaffold }));
      return 0;
    }
    write(
      res.skipped
        ? `${res.path} already exists. Pass --force to re-download.`
        : `Downloaded pocketbase ${res.version} (${res.os}/${res.arch}) → ${res.path}`,
    );
    for (const r of scaffold) write(`  ${r.status.padEnd(8)} ${r.path}`);
    if (!res.skipped) {
      write(
        `  updated  ${
          join(dir, "pb.json")
        } (pocketbaseVersion: ${res.version})`,
      );
      if (!res.checksumVerified) console.error(NO_CHECKSUM_WARNING);
    }
    write(startHint(deps, dir, res.path));
    return 0;
  };

  const versions: Handler = async (ctx: CmdCtx) => {
    const { versions: list, source } = await listVersions(deps, {
      all: ctx.raw.all === true,
      pre: ctx.raw.pre === true,
    });
    const latest = source === "github" && list.length > 0 ? list[0] : null;

    if (ctx.flags.json) {
      write(JSON.stringify({ versions: list, source, latest }));
      return 0;
    }
    if (source === "builtin") {
      console.error(
        "Offline — showing a built-in list, which may be out of date.",
      );
    }
    for (const v of list) write(v === latest ? `  ${v}   latest` : `  ${v}`);
    if (!ctx.raw.all) {
      write(`  (${list.length} shown, --all for every release)`);
    }
    return 0;
  };

  const which: Handler = async (ctx: CmdCtx) => {
    const dir = dirOf(deps, ctx);
    const platform = detectPlatform({
      os: ctx.raw.os as string | undefined,
      arch: ctx.raw.arch as string | undefined,
    });
    const path = join(dir, platform.binName);
    if (!await deps.stat(path)) {
      throw new CliError(
        `No PocketBase binary in ${dir}. Run \`pb init\` to download one.`,
        1,
      );
    }
    const version = await readPin(deps, dir);
    if (ctx.flags.json) {
      write(JSON.stringify({ path, version }));
      return 0;
    }
    write(`${path} (${version ?? "unknown — no pin in pb.json"})`);
    return 0;
  };

  return { init, install, versions, which };
}
