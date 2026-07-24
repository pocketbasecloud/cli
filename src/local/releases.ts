import { CliError } from "../errors.ts";
import type { LocalDeps } from "./deps.ts";

const REPO = "pocketbase/pocketbase";
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;
const DEFAULT_LIMIT = 20;

/**
 * Offline fallback: the newest release of each maintained line plus recent
 * patches, as observed on 2026-07-23. This is a convenience for listing, not a
 * source of truth, and is not expected to be kept current — which is why
 * anything derived from it is labelled "builtin" and why `latest` refuses to
 * resolve from it.
 */
export const FALLBACK_VERSIONS: readonly string[] = [
  "0.39.9",
  "0.39.8",
  "0.39.7",
  "0.39.6",
  "0.34.2",
  "0.34.1",
  "0.22.50",
  "0.22.49",
  "0.22.48",
  "0.22.47",
];

export type VersionList = { versions: string[]; source: "github" | "builtin" };

type NetDeps = Pick<LocalDeps, "fetch" | "env">;

export function normalizeVersion(v: string): string {
  return v.replace(/^v/, "");
}

/**
 * Descending semver order. A version with a prerelease suffix sorts below the
 * same version without one.
 */
export function compareSemverDesc(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    const nums = core.split(".").map((n) => parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pb.nums[i] ?? 0) - (pa.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (pa.pre && !pb.pre) return 1;
  if (!pa.pre && pb.pre) return -1;
  return (pb.pre ?? "").localeCompare(pa.pre ?? "");
}

export function assetUrl(version: string, assetName: string): string {
  return `${DOWNLOAD_BASE}/v${version}/${assetName}`;
}

export function checksumsUrl(version: string): string {
  return `${DOWNLOAD_BASE}/v${version}/checksums.txt`;
}

type ApiRelease = { tag_name: string; draft: boolean; prerelease: boolean };

export async function listVersions(
  deps: NetDeps,
  opts: { all?: boolean; pre?: boolean } = {},
): Promise<VersionList> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
  };
  const token = deps.env("GITHUB_TOKEN") ?? deps.env("GH_TOKEN");
  if (token) headers["authorization"] = `Bearer ${token}`;

  let releases: ApiRelease[];
  try {
    const res = await deps.fetch(API_URL, { headers });
    if (!res.ok) return { versions: [...FALLBACK_VERSIONS], source: "builtin" };
    releases = await res.json() as ApiRelease[];
  } catch {
    // No network, DNS failure, timeout — anything at all.
    return { versions: [...FALLBACK_VERSIONS], source: "builtin" };
  }

  const versions = releases
    .filter((r) => !r.draft && (opts.pre || !r.prerelease))
    .map((r) => normalizeVersion(r.tag_name))
    .sort(compareSemverDesc);

  return {
    versions: opts.all ? versions : versions.slice(0, DEFAULT_LIMIT),
    source: "github",
  };
}

export async function resolveLatest(deps: NetDeps): Promise<string> {
  const { versions, source } = await listVersions(deps);
  if (source === "builtin" || versions.length === 0) {
    throw new CliError(
      "Could not reach the GitHub releases API, so `latest` cannot be resolved. " +
        "Pass an explicit version, e.g. `pb install 0.39.9`, or see " +
        "`pb versions` for the built-in list.",
      1,
    );
  }
  return versions[0];
}
