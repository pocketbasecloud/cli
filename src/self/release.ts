import { CliError } from "../errors.ts";
import {
  assetName,
  hostMap,
  type Target,
  targetForHost,
  TARGETS,
} from "../../scripts/targets.ts";

const REPO = "pocketbasecloud/cli";
const RELEASES = `https://github.com/${REPO}/releases`;

const ASSET_RE =
  /^pb_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_[a-z0-9]+_[a-z0-9]+\.(?:tar\.gz|zip)$/;

export type ReleaseManifest = {
  version: string;
  checksums: Record<string, string>;
};

export function checksumsUrl(version?: string): string {
  return version
    ? `${RELEASES}/download/v${version}/checksums.txt`
    : `${RELEASES}/latest/download/checksums.txt`;
}

export function assetUrl(version: string, name: string): string {
  return `${RELEASES}/download/v${version}/${name}`;
}

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
        `Install manually from ${RELEASES}.`);
  }
  return { version, checksums };
}

export function hostAsset(
  key: string,
  version: string,
): { target: Target; name: string } {
  const target = targetForHost(key);
  if (!target) {
    throw new CliError(
      `No prebuilt pbc binary for ${key}. ` +
        `Supported: ${Object.keys(hostMap(TARGETS)).join(", ")}. ` +
        "On any other platform, install from source with Deno.",
        { code: "USAGE" });
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
      `Could not reach GitHub to check for a newer pbc: ${
        e instanceof Error ? e.message : String(e)
      }`);
  }
  if (res.status === 404) {
    await res.body?.cancel();
    throw new CliError(
      version
        ? `pbc ${version} is not a published release. See ${RELEASES}.`
        : `No published pbc release found. See ${RELEASES}.`,
        { code: "USAGE" });
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new CliError(
      `Could not fetch the release manifest (${res.status}). Try again shortly.`);
  }
  return parseChecksums(await res.text());
}
