import { CliError } from "../errors.ts";
import type { LocalDeps } from "./deps.ts";

const REPO = "pocketbase/pocketbase";
const NEW_HOST = "https://ganigeorgiev.com";
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const NEW_HOST_API_URL =
  `${NEW_HOST}/api/collections/releases/records?perPage=500&skipTotal=1&fields=tag,draft,files`;
const ASSET_PREFIX = "pocketbase_";
const DEFAULT_LIMIT = 20;

export const DOWNLOAD_BASES: readonly string[] = [
  `${NEW_HOST}/meta/${REPO}/download`,
  `https://github.com/${REPO}/releases/download`,
];

export const FALLBACK_VERSIONS: readonly string[] = [
  "0.41.1",
  "0.41.0",
  "0.40.5",
  "0.40.4",
  "0.40.3",
  "0.40.2",
  "0.40.1",
  "0.40.0",
  "0.39.11",
  "0.39.10",
  "0.39.9",
  "0.39.8",
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

export function assetUrl(
  version: string,
  assetName: string,
  base: string,
): string {
  return `${base}/v${version}/${assetName}`;
}

export function checksumsUrl(version: string, base: string): string {
  return `${base}/v${version}/checksums.txt`;
}

type ApiRelease = { tag_name: string; draft: boolean; prerelease: boolean };
type HostRelease = { tag: string; draft: boolean; files: string[] };

function fromHostRelease(r: HostRelease): ApiRelease | null {
  if (!r.files.some((f) => f.startsWith(ASSET_PREFIX))) return null;
  return { tag_name: r.tag, draft: r.draft, prerelease: r.tag.includes("-") };
}

async function fetchJson<T>(
  deps: NetDeps,
  url: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await deps.fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return await res.json() as T;
}

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
    const [github, host] = await Promise.all([
      fetchJson<ApiRelease[]>(deps, API_URL, headers),
      fetchJson<{ items: HostRelease[] }>(deps, NEW_HOST_API_URL),
    ]);
    const hostReleases = host.items
      .map(fromHostRelease)
      .filter((r): r is ApiRelease => r !== null);
    releases = [...github, ...hostReleases];
  } catch {
    return { versions: [...FALLBACK_VERSIONS], source: "builtin" };
  }

  const versions = [
    ...new Set(
      releases
        .filter((r) => !r.draft && (opts.pre || !r.prerelease))
        .map((r) => normalizeVersion(r.tag_name)),
    ),
  ].sort(compareSemverDesc);

  return {
    versions: opts.all ? versions : versions.slice(0, DEFAULT_LIMIT),
    source: "github",
  };
}

export async function resolveLatest(deps: NetDeps): Promise<string> {
  const { versions, source } = await listVersions(deps);
  if (source === "builtin" || versions.length === 0) {
    throw new CliError(
      "Could not reach the PocketBase releases APIs, so `latest` cannot be resolved. " +
        "Pass an explicit version, e.g. `pbc install 0.39.9`, or see " +
        "`pbc versions` for the built-in list.");
  }
  return versions[0];
}
