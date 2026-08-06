import { CliError } from "../errors.ts";
import {
  assetName,
  hostMap,
  type Target,
  targetForHost,
  TARGETS,
} from "../../scripts/targets.ts";

/** Where `pb`'s own releases live — not the PocketBase repo. */
const REPO = "pocketbasecloud/cli";
const RELEASES = `https://github.com/${REPO}/releases`;

/**
 * `pb_<version>_<os>_<arch>.<ext>` — the names `assetName()` produces, read
 * back. The version is the only part that varies per release, which is what
 * makes checksums.txt a version oracle as well as a digest list.
 */
const ASSET_RE =
  /^pb_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_[a-z0-9]+_[a-z0-9]+\.(?:tar\.gz|zip)$/;

export type ReleaseManifest = {
  version: string;
  /** Asset filename → lowercase SHA-256 hex. */
  checksums: Record<string, string>;
};

/**
 * `checksums.txt` for a release, or for the latest one when `version` is
 * omitted. `latest/download/<name>` is a plain redirect, so resolving the
 * newest version this way costs no GitHub API quota — unauthenticated callers
 * get 60 requests an hour, and `pb upgrade` must work on the 61st.
 */
export function checksumsUrl(version?: string): string {
  return version
    ? `${RELEASES}/download/v${version}/checksums.txt`
    : `${RELEASES}/latest/download/checksums.txt`;
}

export function assetUrl(version: string, name: string): string {
  return `${RELEASES}/download/v${version}/${name}`;
}

/**
 * Reads the `<sha256>  <filename>` lines GitHub serves alongside each release.
 * The version comes from the asset names rather than being passed in, so the
 * `latest` redirect resolves to a concrete version in the same request that
 * fetches the digests used to verify the download.
 */
export function parseChecksums(text: string): ReleaseManifest {
  const checksums: Record<string, string> = {};
  let version = "";
  for (const line of text.split("\n")) {
    const [digest, name] = line.trim().split(/\s+/);
    if (!digest || !name) continue;
    checksums[name] = digest.toLowerCase();
    const m = ASSET_RE.exec(name);
    if (m && !version) version = m[1];
  }
  if (!version) {
    throw new CliError(
      "Could not read a version from the release's checksums.txt. " +
        `Install manually from ${RELEASES}.`,
      1,
    );
  }
  return { version, checksums };
}

/** The release archive this host needs, and the target that serves it. */
export function hostAsset(
  key: string,
  version: string,
): { target: Target; name: string } {
  const target = targetForHost(key);
  if (!target) {
    throw new CliError(
      `No prebuilt pb binary for ${key}. ` +
        `Supported: ${Object.keys(hostMap(TARGETS)).join(", ")}. ` +
        "On any other platform, install from source with Deno.",
      2,
    );
  }
  return { target, name: assetName(target, version) };
}

export async function fetchManifest(
  doFetch: typeof fetch,
  version?: string,
): Promise<ReleaseManifest> {
  let res: Response;
  try {
    res = await doFetch(checksumsUrl(version));
  } catch (e) {
    throw new CliError(
      `Could not reach GitHub to check for a newer pb: ${
        e instanceof Error ? e.message : String(e)
      }`,
      1,
    );
  }
  if (res.status === 404) {
    // Consume the body so the connection is not left dangling.
    await res.body?.cancel();
    throw new CliError(
      version
        ? `pb ${version} is not a published release. See ${RELEASES}.`
        : `No published pb release found. See ${RELEASES}.`,
      2,
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new CliError(
      `Could not fetch the release manifest (${res.status}). Try again shortly.`,
      1,
    );
  }
  return parseChecksums(await res.text());
}
