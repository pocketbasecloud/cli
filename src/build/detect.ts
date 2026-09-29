import { dirname, join, resolve } from "@std/path";
import type { BuildConfig } from "../config.ts";
import type { ResourceKind } from "../clients/types.ts";
import {
  inferPythonStart,
  isPythonProject,
  PYTHON_MANIFESTS,
  pythonFilesToRead,
  type PythonVersion,
  resolvePythonVersion,
} from "./python-detect.ts";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function findConfig(
  dir: string,
  stem: string,
): Promise<string | undefined> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.startsWith(`${stem}.`)) return entry.name;
    }
  } catch {
    // Unreadable directory behaves like an absent config.
  }
  return undefined;
}

async function hasConfig(dir: string, stem: string): Promise<boolean> {
  return await findConfig(dir, stem) !== undefined;
}

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export async function detectPackageManager(
  dir: string,
): Promise<PackageManager> {
  for (const [file, manager] of LOCKFILES) {
    if (await exists(join(dir, file))) return manager;
  }
  return "npm";
}

export async function findPackageManagerRoot(
  dir: string,
): Promise<{ dir: string; manager: PackageManager } | null> {
  let current = resolve(dir);
  while (true) {
    if (await exists(join(current, "package.json"))) {
      for (const [file, manager] of LOCKFILES) {
        if (await exists(join(current, file))) return { dir: current, manager };
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function buildScript(dir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
    const script = pkg?.scripts?.build;
    return typeof script === "string" && script.length > 0 ? script : null;
  } catch {
    return null;
  }
}

async function inferCommand(dir: string): Promise<string | undefined> {
  if (!await buildScript(dir)) return undefined;
  return `${await detectPackageManager(dir)} run build`;
}

async function hasStartScript(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
    return typeof pkg?.scripts?.start === "string" &&
      pkg.scripts.start.length > 0;
  } catch {
    return false;
  }
}

async function hasDenoStartTask(dir: string): Promise<boolean> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      const cfg = JSON.parse(await Deno.readTextFile(join(dir, name)));
      const task = cfg?.tasks?.start;
      if (typeof task === "string" && task.length > 0) return true;
    } catch {
      // Missing or unparseable: try the other name, then give up.
    }
  }
  return false;
}

async function firstExisting(
  dir: string,
  candidates: string[],
): Promise<string | undefined> {
  for (const c of candidates) {
    if (await exists(join(dir, c))) return c;
  }
  return undefined;
}

const LISTING_SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  "pb_data",
]);

async function isVirtualenv(path: string): Promise<boolean> {
  return await exists(join(path, "pyvenv.cfg"));
}

export async function listProjectPaths(dir: string): Promise<string[]> {
  const paths: string[] = [];
  const subdirs: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) paths.push(entry.name);
      else if (entry.isDirectory && !LISTING_SKIPPED_DIRS.has(entry.name)) {
        subdirs.push(entry.name);
      }
    }
    for (const sub of subdirs) {
      if (await isVirtualenv(join(dir, sub))) continue;
      for await (const entry of Deno.readDir(join(dir, sub))) {
        if (entry.isFile) paths.push(`${sub}/${entry.name}`);
      }
    }
  } catch {
    return paths;
  }
  return paths;
}

async function readPythonTexts(
  dir: string,
  paths: string[],
): Promise<Record<string, string>> {
  const texts: Record<string, string> = {};
  for (const path of pythonFilesToRead(paths)) {
    try {
      texts[path] = await Deno.readTextFile(join(dir, path));
    } catch {
      continue;
    }
  }
  return texts;
}

export async function hasPythonManifestIn(dir: string): Promise<boolean> {
  return await firstExisting(dir, PYTHON_MANIFESTS) !== undefined;
}

export async function hasPythonProject(dir: string): Promise<boolean> {
  return isPythonProject(await listProjectPaths(dir));
}

export async function detectPythonVersion(
  dir: string,
): Promise<PythonVersion> {
  const paths = await listProjectPaths(dir);
  return resolvePythonVersion(await readPythonTexts(dir, paths));
}

async function inferPython(dir: string): Promise<BuildConfig | undefined> {
  const paths = await listProjectPaths(dir);
  if (!isPythonProject(paths)) return undefined;
  const { startCommand } = inferPythonStart(
    paths,
    await readPythonTexts(dir, paths),
  );
  return { runtime: "python", outputDir: ".", startCommand };
}

async function inferFrontend(dir: string): Promise<BuildConfig> {
  const command = await inferCommand(dir);
  if (await hasConfig(dir, "next.config")) return { command, outputDir: "out" };
  if (await hasConfig(dir, "vite.config")) {
    return { command, outputDir: "dist" };
  }
  if (await exists(join(dir, "svelte.config.js"))) {
    return { command, outputDir: "build" };
  }
  if (await hasConfig(dir, "astro.config")) {
    return { command, outputDir: "dist" };
  }
  if (await exists(join(dir, "angular.json"))) {
    return { command, outputDir: "dist" };
  }
  if (command) {
    return {
      command,
      outputDir: await firstExisting(dir, ["dist", "build", "out"]) ?? "dist",
    };
  }
  return { outputDir: "." };
}

async function inferBackend(dir: string): Promise<BuildConfig> {
  if (await hasConfig(dir, "next.config")) {
    return { command: await inferCommand(dir), runtime: "nextjs" };
  }
  if (
    await exists(join(dir, "deno.json")) ||
    await exists(join(dir, "deno.jsonc"))
  ) {
    return {
      runtime: "deno",
      outputDir: ".",
      startCommand: await hasDenoStartTask(dir) ? "deno task start" : undefined,
    };
  }
  if (await detectPackageManager(dir) === "bun") {
    return {
      runtime: "bun",
      outputDir: ".",
      startCommand: await hasStartScript(dir) ? "bun run start" : undefined,
    };
  }
  if (await exists(join(dir, "package.json"))) {
    return {
      command: await inferCommand(dir),
      runtime: "nodejs",
      outputDir: ".",
      startCommand: await hasStartScript(dir)
        ? `${await detectPackageManager(dir)} run start`
        : undefined,
    };
  }
  return await inferPython(dir) ?? { outputDir: "." };
}

async function inferPocketBase(dir: string): Promise<BuildConfig> {
  const out: BuildConfig = {};
  if (await exists(join(dir, "pb_public"))) out.pbPublic = "pb_public";
  if (await exists(join(dir, "pb_hooks"))) out.pbHooks = "pb_hooks";
  if (await exists(join(dir, "pb_migrations"))) {
    out.pbMigrations = "pb_migrations";
  }
  return out;
}

export function inferBuild(
  dir: string,
  kind: ResourceKind,
): Promise<BuildConfig> {
  if (kind === "frontends") return inferFrontend(dir);
  if (kind === "backends") return inferBackend(dir);
  return inferPocketBase(dir);
}

export function describeBuild(cfg: BuildConfig): string[] {
  const lines: string[] = [];
  const add = (k: string, v: string | undefined) =>
    v === undefined ? undefined : lines.push(`  ${k}: ${v}`);
  add("command", cfg.command);
  add("runtime", cfg.runtime);
  add("pythonVersion", cfg.pythonVersion);
  add("startCommand", cfg.startCommand);
  add("outputDir", cfg.outputDir);
  add("pb_public", cfg.pbPublic);
  add("pb_hooks", cfg.pbHooks);
  add("pb_migrations", cfg.pbMigrations);
  return lines;
}
