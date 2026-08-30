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
  execPath: () => string;
  hostKey: () => string;
};

export type InstallKind = "standalone" | "npm" | "source";
export type InstallInfo = { kind: InstallKind; path: string };

export function detectInstall(execPath: string): InstallInfo {
  const norm = execPath.replace(/\\/g, "/");
  const base = basename(norm).toLowerCase().replace(/\.exe$/, "");
  if (base === "deno") return { kind: "source", path: execPath };
  if (norm.includes("/node_modules/")) return { kind: "npm", path: execPath };
  return { kind: "standalone", path: execPath };
}

export function manualCommand(
  kind: Exclude<InstallKind, "standalone">,
): string {
  return kind === "npm"
    ? `npm i -g ${NPM_PACKAGE}@latest`
    : "git pull && deno install -g -A -c deno.json -n pbc ./main.ts";
}

export type UpgradeAction = "upgrade" | "up-to-date" | "manual";

export type UpgradePlan = {
  current: string;
  target: string;
  install: InstallInfo;
  action: UpgradeAction;
  updateAvailable: boolean;
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

  const updateAvailable = compareSemverDesc(VERSION, target) > 0;

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
      `The release for pbc ${version} lists no checksum for ${name}, ` +
        "so the download cannot be verified. Nothing was changed.");
  }

  let res: Response;
  try {
    res = await deps.fetch(assetUrl(version, name));
  } catch (e) {
    throw new CliError(
      `Download failed for ${name}: ${
        e instanceof Error ? e.message : String(e)
      }`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new CliError(`Download failed (${res.status}) for ${name}.`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new CliError(
      `Checksum mismatch for ${name}.\n  expected ${expected}\n  actual   ${actual}\n` +
        "Nothing was changed. Retry, and if it persists report it upstream.");
  }
  return bytes;
}

function isPermissionError(e: unknown): boolean {
  if (e instanceof Deno.errors.PermissionDenied) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /permission denied|not permitted|EACCES|EPERM/i.test(msg);
}

export async function replaceBinary(
  deps: SelfDeps,
  target: string,
  binary: Uint8Array,
  isWindows: boolean,
): Promise<{ leftBehind?: string }> {
  const dir = dirname(target);
  const tmp = join(dir, `.pbc.upgrade.${crypto.randomUUID().slice(0, 8)}`);

  try {
    await deps.writeFile(tmp, binary);
  } catch (e) {
    if (isPermissionError(e)) {
      throw new CliError(
        `No permission to write to ${dir}.\n` +
          `Re-run with elevated privileges (e.g. \`sudo pbc self upgrade\`), or ` +
          `reinstall into a directory you own with ` +
          `\`PBC_INSTALL_DIR=$HOME/.local/bin\`.`);
    }
    throw e;
  }

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
        await deps.rename(aside, target).catch(() => {});
        throw e;
      }
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
          `Re-run with elevated privileges (e.g. \`sudo pbc self upgrade\`), or ` +
          `reinstall into a directory you own with ` +
          `\`PBC_INSTALL_DIR=$HOME/.local/bin\`.`);
    }
    throw e;
  }

  return { leftBehind };
}

export type UpgradeResult = { path: string; leftBehind?: string };

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
