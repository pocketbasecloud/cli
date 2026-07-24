import { join } from "@std/path";
import { CliError } from "../errors.ts";
import type { LocalDeps } from "./deps.ts";
import { detectPlatform } from "./platform.ts";
import { extractEntry } from "./unzip.ts";
import {
  assetUrl,
  checksumsUrl,
  normalizeVersion,
  resolveLatest,
} from "./releases.ts";

const PB_JSON = "pb.json";

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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifies the archive against the release's checksums.txt.
 * Returns false when checksums.txt is unavailable (older releases) — a
 * mismatch throws.
 */
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

  // Format: "<sha256 hex><two spaces><filename>"
  const line = text.split("\n").find((l) => l.trim().endsWith(assetName));
  if (!line) return false;
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = await sha256Hex(zip);
  if (expected !== actual) {
    throw new CliError(
      `Checksum mismatch for ${assetName}.\n  expected ${expected}\n  actual   ${actual}\n` +
        "Nothing was written. Retry, and if it persists report it upstream.",
      1,
    );
  }
  return true;
}

export async function installBinary(
  deps: LocalDeps,
  opts: InstallOpts,
): Promise<InstallResult> {
  const platform = detectPlatform({ os: opts.os, arch: opts.arch });
  const target = join(opts.dir, platform.binName);

  // Check for an existing binary before resolving `latest`, so a no-op install
  // costs no network call and never reports a version it did not install.
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
        "Run `pb versions` to see what is available.",
      2,
    );
  }
  if (!res.ok) {
    throw new CliError(`Download failed (${res.status}) for ${assetName}.`, 1);
  }

  const zip = new Uint8Array(await res.arrayBuffer());
  const checksumVerified = await verifyChecksum(deps, version, assetName, zip);
  const binary = await extractEntry(zip, platform.binName);

  // Write to a temp path in the same directory, then rename, so an interrupted
  // run can never leave a truncated binary at the final path.
  const tmp = join(opts.dir, `.${platform.binName}.download`);
  await deps.mkdir(opts.dir);
  await deps.writeFile(tmp, binary);
  await deps.chmod(tmp, 0o755).catch(() => {}); // no-op on Windows
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

async function readPbJson(
  deps: LocalDeps,
  dir: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await deps.readTextFile(join(dir, PB_JSON)));
  } catch {
    // Absent or unparseable — either way we start fresh rather than fail an
    // install over it.
    return {};
  }
}

/** Merges the version pin into pb.json, preserving any cloud link. */
export async function pinVersion(
  deps: LocalDeps,
  dir: string,
  version: string,
): Promise<void> {
  const current = await readPbJson(deps, dir);
  await deps.writeTextFile(
    join(dir, PB_JSON),
    JSON.stringify({ ...current, pocketbaseVersion: version }, null, 2) + "\n",
  );
}

export async function readPin(
  deps: LocalDeps,
  dir: string,
): Promise<string | null> {
  const current = await readPbJson(deps, dir);
  const pin = current["pocketbaseVersion"];
  return typeof pin === "string" && pin.length > 0 ? pin : null;
}
