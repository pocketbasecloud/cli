import { join } from "@std/path";
import { CliError } from "../errors.ts";
import { sha256Hex } from "../hash.ts";
import { LEGACY_LINK_FILE, LINK_FILE } from "../config.ts";
import type { LocalDeps } from "./deps.ts";
import { detectPlatform } from "./platform.ts";
import { extractEntry } from "./unzip.ts";
import {
  assetUrl,
  checksumsUrl,
  normalizeVersion,
  resolveLatest,
} from "./releases.ts";

export type InstallOpts = {
  version?: string;
  dir: string;
  force?: boolean;
  os?: string;
  arch?: string;
};

export type InstallResult = {
  path: string;
  version: string;
  os: string;
  arch: string;
  skipped: boolean;
  checksumVerified: boolean;
};

async function verifyChecksum(
  deps: LocalDeps,
  version: string,
  assetName: string,
  zip: Uint8Array,
): Promise<boolean> {
  let text: string;
  try {
    const res = await deps.fetch(checksumsUrl(version));
    if (!res.ok) return false;
    text = await res.text();
  } catch {
    return false;
  }

  const line = text.split("\n").find((l) => l.trim().endsWith(assetName));
  if (!line) return false;
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = await sha256Hex(zip);
  if (expected !== actual) {
    throw new CliError(
      `Checksum mismatch for ${assetName}.\n  expected ${expected}\n  actual   ${actual}\n` +
        "Nothing was written. Retry, and if it persists report it upstream.");
  }
  return true;
}

export async function installBinary(
  deps: LocalDeps,
  opts: InstallOpts,
): Promise<InstallResult> {
  const platform = detectPlatform({ os: opts.os, arch: opts.arch });
  const target = join(opts.dir, platform.binName);

  if (!opts.force && await deps.stat(target)) {
    return {
      path: target,
      version: opts.version ? normalizeVersion(opts.version) : "",
      os: platform.os,
      arch: platform.arch,
      skipped: true,
      checksumVerified: false,
    };
  }

  const version = opts.version
    ? normalizeVersion(opts.version)
    : await resolveLatest(deps);

  const assetName = platform.assetName(version);
  const res = await deps.fetch(assetUrl(version, assetName));
  if (res.status === 404) {
    throw new CliError(
      `PocketBase ${version} has no ${platform.os}/${platform.arch} build. ` +
        "Run `pbc versions` to see what is available.", { code: "USAGE" });
  }
  if (!res.ok) {
    throw new CliError(`Download failed (${res.status}) for ${assetName}.`);
  }

  const zip = new Uint8Array(await res.arrayBuffer());
  const checksumVerified = await verifyChecksum(deps, version, assetName, zip);
  const binary = await extractEntry(zip, platform.binName);

  const tmp = join(opts.dir, `.${platform.binName}.download`);
  await deps.mkdir(opts.dir);
  await deps.writeFile(tmp, binary);
  await deps.chmod(tmp, 0o755).catch(() => {});
  await deps.rename(tmp, target);

  return {
    path: target,
    version,
    os: platform.os,
    arch: platform.arch,
    skipped: false,
    checksumVerified,
  };
}

export async function linkFileIn(
  deps: LocalDeps,
  dir: string,
): Promise<string> {
  for (const name of [LINK_FILE, LEGACY_LINK_FILE]) {
    const path = join(dir, name);
    if ((await deps.stat(path))?.isFile) return path;
  }
  return join(dir, LINK_FILE);
}

async function readLinkFileIn(
  deps: LocalDeps,
  dir: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await deps.readTextFile(await linkFileIn(deps, dir)));
  } catch {
    return {};
  }
}

export async function pinVersion(
  deps: LocalDeps,
  dir: string,
  version: string,
): Promise<void> {
  const current = await readLinkFileIn(deps, dir);
  await deps.writeTextFile(
    await linkFileIn(deps, dir),
    JSON.stringify({ ...current, pocketbaseVersion: version }, null, 2) + "\n",
  );
}

export async function readPin(
  deps: LocalDeps,
  dir: string,
): Promise<string | null> {
  const current = await readLinkFileIn(deps, dir);
  const pin = current["pocketbaseVersion"];
  return typeof pin === "string" && pin.length > 0 ? pin : null;
}
