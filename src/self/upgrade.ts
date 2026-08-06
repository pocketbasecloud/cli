import { basename, dirname, join } from "@std/path";
import { CliError } from "../errors.ts";
import { sha256Hex } from "../hash.ts";
import { VERSION } from "../version.ts";
import type { LocalDeps } from "../local/deps.ts";
import { compareSemverDesc, normalizeVersion } from "../local/releases.ts";
import { extractEntry } from "../local/unzip.ts";
import { extractFromTarGz } from "./untar.ts";
import {
  assetUrl,
  fetchManifest,
  hostAsset,
  type ReleaseManifest,
} from "./release.ts";

const NPM_PACKAGE = "@pocketbasecloud/cli";

export type SelfDeps = LocalDeps & {
  /** Absolute path of the binary currently executing. */
  execPath: () => string;
  /** This machine as a `${process.platform}-${process.arch}` key. */
  hostKey: () => string;
};

/**
 * How this copy of `pb` got here, which decides whether it can replace itself.
 *
 * - `standalone` — a compiled binary on PATH, from `install.sh` or a release
 *   archive. Nothing else owns the file, so `pb upgrade` swaps it directly.
 * - `npm` — running out of `node_modules/@pocketbasecloud/cli-<key>/bin/`.
 *   Overwriting that file would be silently reverted by the next `npm i`, and
 *   the shim pins its platform package to an exact version, so the two have to
 *   move together. npm is the only thing that can do that.
 * - `source` — `deno run`/`deno install`, where `execPath()` is Deno itself.
 *   There is no `pb` binary to replace; the clone is the install.
 */
export type InstallKind = "standalone" | "npm" | "source";
export type InstallInfo = { kind: InstallKind; path: string };

export function detectInstall(execPath: string): InstallInfo {
  const norm = execPath.replace(/\\/g, "/");
  const base = basename(norm).toLowerCase().replace(/\.exe$/, "");
  if (base === "deno") return { kind: "source", path: execPath };
  if (norm.includes("/node_modules/")) return { kind: "npm", path: execPath };
  return { kind: "standalone", path: execPath };
}

/** The command that upgrades an install `pb` cannot upgrade itself. */
export function manualCommand(
  kind: Exclude<InstallKind, "standalone">,
): string {
  return kind === "npm"
    ? `npm i -g ${NPM_PACKAGE}@latest`
    : "git pull && deno install -g -A -c deno.json -n pb ./main.ts";
}

export type UpgradeAction = "upgrade" | "up-to-date" | "manual";

export type UpgradePlan = {
  current: string;
  /** The version that would be installed — the newest, or the one requested. */
  target: string;
  install: InstallInfo;
  action: UpgradeAction;
  /** True when `target` is strictly newer than `current`. */
  updateAvailable: boolean;
  /** Set when `action` is "manual". */
  command?: string;
};

export type PlanOpts = { version?: string; force?: boolean };

export async function planUpgrade(
  deps: SelfDeps,
  opts: PlanOpts = {},
): Promise<{ plan: UpgradePlan; manifest: ReleaseManifest }> {
  const requested = opts.version ? normalizeVersion(opts.version) : undefined;
  const manifest = await fetchManifest(deps.fetch, requested);
  const install = detectInstall(deps.execPath());
  const target = manifest.version;

  // compareSemverDesc sorts newest-first, so a positive result means the
  // right-hand side is the newer of the two.
  const updateAvailable = compareSemverDesc(VERSION, target) > 0;

  // An explicit version is an instruction, not a suggestion: it may be a
  // downgrade, and that is a legitimate way to get off a bad release.
  const wants = requested ? target !== VERSION : updateAvailable;

  let action: UpgradeAction;
  let command: string | undefined;
  if (!wants && !opts.force) {
    action = "up-to-date";
  } else if (install.kind === "standalone") {
    action = "upgrade";
  } else {
    action = "manual";
    command = manualCommand(install.kind);
  }

  return {
    manifest,
    plan: {
      current: VERSION,
      target,
      install,
      action,
      updateAvailable,
      ...(command ? { command } : {}),
    },
  };
}

async function download(
  deps: SelfDeps,
  version: string,
  name: string,
  expected: string | undefined,
): Promise<Uint8Array> {
  if (!expected) {
    throw new CliError(
      `The release for pb ${version} lists no checksum for ${name}, ` +
        "so the download cannot be verified. Nothing was changed.",
      1,
    );
  }

  let res: Response;
  try {
    res = await deps.fetch(assetUrl(version, name));
  } catch (e) {
    throw new CliError(
      `Download failed for ${name}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      1,
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new CliError(`Download failed (${res.status}) for ${name}.`, 1);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new CliError(
      `Checksum mismatch for ${name}.\n  expected ${expected}\n  actual   ${actual}\n` +
        "Nothing was changed. Retry, and if it persists report it upstream.",
      1,
    );
  }
  return bytes;
}

function isPermissionError(e: unknown): boolean {
  if (e instanceof Deno.errors.PermissionDenied) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /permission denied|not permitted|EACCES|EPERM/i.test(msg);
}

/**
 * Swaps the running binary for `binary`.
 *
 * On POSIX a running executable cannot be written to (ETXTBSY) but its
 * directory entry can be replaced: `rename` is atomic and the running process
 * keeps the old inode until it exits. Windows forbids renaming *onto* a
 * running image but allows renaming the image itself out of the way, so the
 * old file is moved aside first and deleted if the OS lets go of it.
 */
export async function replaceBinary(
  deps: SelfDeps,
  target: string,
  binary: Uint8Array,
  isWindows: boolean,
): Promise<{ leftBehind?: string }> {
  const dir = dirname(target);
  const tmp = join(dir, `.pb.upgrade.${crypto.randomUUID().slice(0, 8)}`);

  try {
    await deps.writeFile(tmp, binary);
  } catch (e) {
    if (isPermissionError(e)) {
      throw new CliError(
        `No permission to write to ${dir}.\n` +
          `Re-run with elevated privileges (e.g. \`sudo pb upgrade\`), or ` +
          `reinstall into a directory you own with ` +
          `\`PB_INSTALL_DIR=$HOME/.local/bin\`.`,
        1,
      );
    }
    throw e;
  }

  // A binary that cannot be executed is worse than no upgrade at all, so give
  // up before anything replaces the working copy.
  try {
    await deps.chmod(tmp, 0o755);
  } catch {
    // Windows has no POSIX mode bits; the write above is what matters there.
  }

  let leftBehind: string | undefined;
  try {
    if (isWindows) {
      const aside = `${target}.old`;
      await deps.remove(aside).catch(() => {});
      await deps.rename(target, aside);
      try {
        await deps.rename(tmp, target);
      } catch (e) {
        // Put the working binary back rather than leaving nothing on PATH.
        await deps.rename(aside, target).catch(() => {});
        throw e;
      }
      // The image is still mapped by this process, so this usually fails; the
      // next upgrade clears it.
      leftBehind = await deps.remove(aside).then(() => undefined).catch(() =>
        aside
      );
    } else {
      await deps.rename(tmp, target);
    }
  } catch (e) {
    await deps.remove(tmp).catch(() => {});
    if (isPermissionError(e)) {
      throw new CliError(
        `No permission to replace ${target}.\n` +
          `Re-run with elevated privileges (e.g. \`sudo pb upgrade\`), or ` +
          `reinstall into a directory you own with ` +
          `\`PB_INSTALL_DIR=$HOME/.local/bin\`.`,
        1,
      );
    }
    throw e;
  }

  return { leftBehind };
}

export type UpgradeResult = { path: string; leftBehind?: string };

/** Downloads, verifies, and installs `plan.target`. Only valid for standalone. */
export async function applyUpgrade(
  deps: SelfDeps,
  plan: UpgradePlan,
  manifest: ReleaseManifest,
): Promise<UpgradeResult> {
  const key = deps.hostKey();
  const { target: hostTarget, name } = hostAsset(key, plan.target);
  const bytes = await download(
    deps,
    plan.target,
    name,
    manifest.checksums[name],
  );

  const binary = name.endsWith(".zip")
    ? await extractEntry(bytes, hostTarget.binName)
    : await extractFromTarGz(bytes, hostTarget.binName);

  const { leftBehind } = await replaceBinary(
    deps,
    plan.install.path,
    binary,
    hostTarget.os === "win32",
  );
  return { path: plan.install.path, leftBehind };
}
