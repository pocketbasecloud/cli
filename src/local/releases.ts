import { CliError } from "../errors.ts";
import type { LocalDeps } from "./deps.ts";

const REPO = "pocketbase/pocketbase";
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;
const DEFAULT_LIMIT = 20;

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

type ParsedVersion = { nums: number[]; pre: string };

function parseVersion(version: string): ParsedVersion {
  const [core, ...rest] = normalizeVersion(version).split("-");
  const nums = core.split(".").map((part) => {
    const parsed = parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return { nums, pre: rest.join("-") };
}

function comparePrerelease(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const length = Math.max(as.length, bs.length);
  for (let i = 0; i < length; i++) {
    const ai = as[i];
    const bi = bs[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNumeric = /^\d+$/.test(ai);
    const bNumeric = /^\d+$/.test(bi);
    if (aNumeric && bNumeric) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else {
      const diff = ai.localeCompare(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function compareSemverDesc(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const length = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < length; i++) {
    const diff = (pb.nums[i] ?? 0) - (pa.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (pa.pre && !pb.pre) return 1;
  if (!pa.pre && pb.pre) return -1;
  if (!pa.pre) return 0;
  return -comparePrerelease(pa.pre, pb.pre);
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
        "Pass an explicit version, e.g. `pbc install 0.39.9`, or see " +
        "`pbc versions` for the built-in list.");
  }
  return versions[0];
}
