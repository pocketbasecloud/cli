import { join } from "@std/path";
import type { ResourceKind } from "../clients/types.ts";
import { type BuildConfig, readOwnLinkFile } from "../config.ts";
import { CliError } from "../errors.ts";
import {
  detectContentKind,
  kindCommand,
  kindDisplay,
  type KindGuess,
} from "./detect-kind.ts";
import { exists, inferBuild } from "./detect.ts";
import { isOsJunkPath } from "./os-junk.ts";
import { pbArchiveShape, zipEntryNames } from "./pb-archive.ts";

const INDEX_HTML_DIRS = ["", "public", "dist", "build", "out"];

const BACKEND_MANIFESTS = [
  "deno.json",
  "deno.jsonc",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "poetry.lock",
  "uv.lock",
];


export type DeploySource = {
  cwd: string;
  zipPath?: string;
  runtime?: string;
};

function withoutWrappers(names: string[]): string[] {
  let current = names
    .map((n) => n.replace(/^\.\//, ""))
    .filter((n) => n && !isOsJunkPath(n) && n.split("/")[0] !== ".git");
  for (;;) {
    const roots = new Set(current.map((n) => n.split("/")[0]));
    if (roots.size !== 1) return current;
    const [root] = roots;
    if (current.some((n) => n === root)) return current;
    current = current.map((n) => n.slice(root.length + 1)).filter(Boolean);
  }
}

function hasIndexHtml(names: string[]): boolean {
  return INDEX_HTML_DIRS.some((dir) =>
    names.includes(dir ? `${dir}/index.html` : "index.html")
  );
}

export function zipContentKind(names: string[]): KindGuess | null {
  const pb = pbArchiveShape(names);
  if (pb.uploadable.length > 0) {
    return {
      kind: "pocketbases",
      reason: pb.uploadable.map((d) => `${d}/`).join(", "),
    };
  }
  const root = withoutWrappers(names);
  const manifest = BACKEND_MANIFESTS.find((m) => root.includes(m));
  if (manifest) return { kind: "backends", reason: manifest };
  if (hasIndexHtml(root)) return { kind: "frontends", reason: "index.html" };
  return null;
}

async function directoryHasIndexHtml(
  cwd: string,
  outputDirs: string[],
): Promise<boolean> {
  for (const dir of [...INDEX_HTML_DIRS, ...outputDirs]) {
    if (await exists(join(cwd, dir, "index.html"))) return true;
  }
  return false;
}

async function recordedBuilds(cwd: string): Promise<BuildConfig[]> {
  const own = await readOwnLinkFile(cwd);
  return [
    own.build ?? {},
    ...Object.values(own.environments ?? {}).map((e) => e.build ?? {}),
  ];
}

async function directoryFailsAs(
  kind: ResourceKind,
  source: DeploySource,
): Promise<boolean> {
  const createsABareInstance = kind === "pocketbases";
  if (createsABareInstance) return false;

  const builds = await recordedBuilds(source.cwd);
  if (kind === "backends") {
    if (source.runtime || builds.some((b) => b.runtime)) return false;
    return !(await inferBuild(source.cwd, "backends")).runtime;
  }
  if (builds.some((b) => b.command)) return false;
  const outputDirs = builds.flatMap((b) => b.outputDir ? [b.outputDir] : []);
  if (await directoryHasIndexHtml(source.cwd, outputDirs)) return false;
  return !(await inferBuild(source.cwd, "frontends")).command;
}

async function zipFailsAs(
  kind: ResourceKind,
  source: DeploySource,
  names: string[],
): Promise<boolean> {
  if (kind === "backends") {
    if (source.runtime) return false;
    return !(await recordedBuilds(source.cwd)).some((b) => b.runtime);
  }
  if (kind === "frontends") return !hasIndexHtml(withoutWrappers(names));
  return pbArchiveShape(names).uploadable.length === 0;
}

async function readZipNames(zipPath: string): Promise<string[] | null> {
  try {
    return zipEntryNames(await Deno.readFile(zipPath));
  } catch {
    return null;
  }
}

function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function describe(guess: KindGuess): string {
  if (guess.kind === "pocketbases") {
    return `This is PocketBase source (${guess.reason})`;
  }
  return `This looks like a ${kindDisplay(guess.kind)} (${guess.reason})`;
}

export async function misdirectedDeploy(
  kind: ResourceKind,
  source: DeploySource,
): Promise<string | null> {
  let guess: KindGuess | null;
  if (source.zipPath) {
    const names = await readZipNames(source.zipPath);
    if (!names) return null;
    guess = zipContentKind(names);
    if (!guess || guess.kind === kind) return null;
    if (!(await zipFailsAs(kind, source, names))) return null;
  } else {
    guess = await detectContentKind(source.cwd);
    if (!guess || guess.kind === kind) return null;
    if (!(await directoryFailsAs(kind, source))) return null;
  }

  const zipFlag = source.zipPath ? ` --zip ${shellWord(source.zipPath)}` : "";
  return `${describe(guess)}, not a ${kindDisplay(kind)}. Deploy it to a ` +
    `${kindDisplay(guess.kind)} instead:\n\n  pbc ${
      kindCommand(guess.kind)
    } deploy${zipFlag}`;
}

export async function assertDeployableAs(
  kind: ResourceKind,
  source: DeploySource,
): Promise<void> {
  const message = await misdirectedDeploy(kind, source);
  if (message) throw new CliError(message, { code: "USAGE" });
}
