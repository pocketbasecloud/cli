import { basename, join } from "@std/path";
import {
  bool,
  type CmdCtx,
  type Command,
  defineCommand,
  str,
} from "../command.ts";
import { CliError } from "../errors.ts";
import { emit } from "../envelope.ts";
import type { LocalDeps } from "../local/deps.ts";
import {
  installBinary,
  linkFileIn,
  pinVersion,
  readPin,
} from "../local/install.ts";
import { scaffoldProject } from "../local/scaffold.ts";
import { listVersions } from "../local/releases.ts";
import { detectPlatform } from "../local/platform.ts";
import { createProgress, type Progress } from "../ui/progress.ts";

const NO_CHECKSUM_WARNING =
  "Warning: no checksums.txt for this release; skipped verification.";

type InputLike = { dir?: string; force?: boolean; os?: string; arch?: string };

function dirOf(deps: LocalDeps, input: { dir?: string }): string {
  return input.dir ?? deps.cwd();
}

function startHint(deps: LocalDeps, dir: string, binPath: string): string {
  const run = `./${basename(binPath)} serve`;
  return dir === deps.cwd()
    ? `\nStart PocketBase with:\n  ${run}`
    : `\nStart PocketBase with:\n  cd ${dir} && ${run}`;
}

function installOptsFrom(deps: LocalDeps, ctx: CmdCtx, input: InputLike) {
  return {
    version: ctx.args[0],
    dir: dirOf(deps, input),
    force: input.force === true,
    os: input.os,
    arch: input.arch,
  };
}

export function makeLocalCommands(
  deps: LocalDeps,
  write: (s: string) => void = console.log,
  progress: Progress = createProgress(),
): Record<string, Command> {
  const download = (ctx: CmdCtx, input: InputLike) =>
    progress.step(
      "Downloading PocketBase",
      () => installBinary(deps, installOptsFrom(deps, ctx, input)),
    );

  return {
    "local init": defineCommand({
      path: ["local", "init"],
      usage: "pbc local init [<version>] [--dir <d>] [--force]",
      summary: "Download a PocketBase binary and scaffold a local project.",
      details: `Downloads the binary for this OS and CPU, then creates pb_hooks/,
pb_migrations/, a README.md, .gitignore entries (which exclude the
binary and pb_data/), and a pocketbaseVersion pin in pbc.json. Existing
files are never overwritten. Omit <version> for the latest release;
--force re-downloads the binary only.

Start the instance afterwards with \`./pocketbase serve\`.`,
      args: [{
        name: "version",
        required: false,
        description: "Release to install, e.g. 0.39.9. Defaults to latest.",
      }],
      flags: {
        dir: str({
          description: "Directory to install into. Defaults to the current directory.",
        }),
        force: bool({
          description: "Re-download the binary even if it is already present.",
        }),
        os: str({
          description: "Override OS detection: darwin, linux, or windows.",
          choices: ["darwin", "linux", "windows"],
        }),
        arch: str({
          description: "Override CPU detection: amd64, arm64, armv7, ppc64le, or s390x.",
          choices: ["amd64", "arm64", "armv7", "ppc64le", "s390x"],
        }),
      },
      run: async (input, ctx) => {
        const dir = dirOf(deps, input);
        const res = await download(ctx, input);
        const scaffold = await scaffoldProject(deps, dir);
        if (!res.skipped) await pinVersion(deps, dir, res.version);

        if (ctx.flags.json) {
          emit(true, { ...res, scaffold }, "", write);
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
            `  updated  ${await linkFileIn(
              deps,
              dir,
            )} (pocketbaseVersion: ${res.version})`,
          );
          if (!res.checksumVerified) console.error(NO_CHECKSUM_WARNING);
        }
        write(startHint(deps, dir, res.path));
        return 0;
      },
    }),

    "local install": defineCommand({
      path: ["local", "install"],
      usage:
        "pbc local install [<version>] [--dir <d>] [--force] [--os <o>] [--arch <a>]",
      summary: "Download a PocketBase binary and record the version pin.",
      details: `Like \`pbc local init\` without the scaffolding. --os/--arch override platform
detection to fetch a build for another machine.

Start the instance afterwards with \`./pocketbase serve\`.`,
      args: [{
        name: "version",
        required: false,
        description: "Release to install, e.g. 0.39.9. Defaults to latest.",
      }],
      flags: {
        dir: str({
          description: "Directory to install into. Defaults to the current directory.",
        }),
        force: bool({
          description: "Re-download the binary even if it is already present.",
        }),
        os: str({
          description: "Override OS detection: darwin, linux, or windows.",
          choices: ["darwin", "linux", "windows"],
        }),
        arch: str({
          description: "Override CPU detection: amd64, arm64, armv7, ppc64le, or s390x.",
          choices: ["amd64", "arm64", "armv7", "ppc64le", "s390x"],
        }),
      },
      run: async (input, ctx) => {
        const dir = dirOf(deps, input);
        const res = await download(ctx, input);
        if (!res.skipped) await pinVersion(deps, dir, res.version);

        if (ctx.flags.json) {
          emit(true, res, "", write);
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
      },
    }),

    "local versions": defineCommand({
      path: ["local", "versions"],
      usage: "pbc local versions [--all] [--pre] [--json]",
      summary: "List available PocketBase versions.",
      details: `Reads the live GitHub releases. Shows the 20 newest by semver; --all
lists every release and --pre includes prereleases. Falls back to a
built-in list, clearly labelled, when GitHub is unreachable.`,
      args: [],
      flags: {
        all: bool({ description: "List every release, not just the 20 newest." }),
        pre: bool({ description: "Include prereleases." }),
      },
      run: async (input, ctx) => {
        const { versions: list, source } = await listVersions(deps, {
          all: input.all === true,
          pre: input.pre === true,
        });
        const latest = source === "github" && list.length > 0 ? list[0] : null;

        if (ctx.flags.json) {
          emit(true, { versions: list, source, latest }, "", write);
          return 0;
        }
        if (source === "builtin") {
          console.error(
            "Offline — showing a built-in list, which may be out of date.",
          );
        }
        for (const v of list) write(v === latest ? `  ${v}   latest` : `  ${v}`);
        if (!input.all) {
          write(`  (${list.length} shown, --all for every release)`);
        }
        return 0;
      },
    }),

    "local which": defineCommand({
      path: ["local", "which"],
      usage: "pbc local which [--dir <d>]",
      summary: "Show the installed PocketBase binary and its pinned version.",
      args: [],
      flags: {
        dir: str({
          description: "Directory to look in. Defaults to the current directory.",
        }),
        os: str({
          description: "Override OS detection: darwin, linux, or windows.",
          choices: ["darwin", "linux", "windows"],
        }),
        arch: str({
          description: "Override CPU detection: amd64, arm64, armv7, ppc64le, or s390x.",
          choices: ["amd64", "arm64", "armv7", "ppc64le", "s390x"],
        }),
      },
      run: async (input, ctx) => {
        const dir = dirOf(deps, input);
        const platform = detectPlatform({
          os: input.os,
          arch: input.arch,
        });
        const path = join(dir, platform.binName);
        if (!await deps.stat(path)) {
          throw new CliError(
            `No PocketBase binary in ${dir}. Run \`pbc local init\` to download one.`);
        }
        const version = await readPin(deps, dir);
        if (ctx.flags.json) {
          emit(true, { path, version }, "", write);
          return 0;
        }
        write(`${path} (${version ?? "unknown — no pin in pbc.json"})`);
        return 0;
      },
    }),
  };
}
