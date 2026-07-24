import { join } from "@std/path";
import { CliError } from "../errors.ts";
import type { BuildConfig } from "../config.ts";
import type { ResourceKind } from "../clients/types.ts";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when any file in `dir` starts with `stem` and has an extension. */
async function hasConfig(dir: string, stem: string): Promise<boolean> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.startsWith(`${stem}.`)) return true;
    }
  } catch {
    // Unreadable directory behaves like an absent config.
  }
  return false;
}

/** Lockfile wins over any `packageManager` field — it is what CI actually ran. */
export async function detectPackageManager(
  dir: string,
): Promise<PackageManager> {
  if (await exists(join(dir, "bun.lockb"))) return "bun";
  if (await exists(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** The `build` script from package.json, or null when there is none. */
async function buildScript(dir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
    const script = pkg?.scripts?.build;
    return typeof script === "string" && script.length > 0 ? script : null;
  } catch {
    return null;
  }
}

/** `<pm> run build`, or undefined when package.json declares no build script. */
async function inferCommand(dir: string): Promise<string | undefined> {
  if (!await buildScript(dir)) return undefined;
  return `${await detectPackageManager(dir)} run build`;
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

async function inferFrontend(dir: string): Promise<BuildConfig> {
  const command = await inferCommand(dir);
  // A Next.js frontend is a static export (`output: "export"` → out/); a
  // Next.js *backend* is the nextjs runtime, handled in inferBackend.
  if (await hasConfig(dir, "next.config")) return { command, outputDir: "out" };
  if (await hasConfig(dir, "vite.config")) {
    return { command, outputDir: "dist" };
  }
  if (await exists(join(dir, "svelte.config.js"))) {
    return { command, outputDir: "build" };
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
    return { runtime: "deno", outputDir: "." };
  }
  if (await exists(join(dir, "bun.lockb"))) {
    return { runtime: "bun", outputDir: "." };
  }
  if (await exists(join(dir, "package.json"))) {
    return {
      command: await inferCommand(dir),
      runtime: "nodejs",
      outputDir: ".",
    };
  }
  // Nothing recognisable: ship the directory as-is and let --runtime decide.
  // Erroring here would block a perfectly valid `--runtime deno` on a project
  // with no manifest.
  return { outputDir: "." };
}

/** The three PocketBase directories, each recorded only if it exists on disk. */
async function inferPocketBase(dir: string): Promise<BuildConfig> {
  const out: BuildConfig = {};
  if (await exists(join(dir, "pb_public"))) out.pbPublic = "pb_public";
  if (await exists(join(dir, "pb_hooks"))) out.pbHooks = "pb_hooks";
  if (await exists(join(dir, "pb_migrations"))) {
    out.pbMigrations = "pb_migrations";
  }
  if (!out.pbPublic && !out.pbHooks && !out.pbMigrations) {
    throw new CliError(
      `No pb_public, pb_hooks, or pb_migrations in ${dir} — nothing to deploy. ` +
        `Add a "build" block to pb.json if they live elsewhere.`,
      2,
    );
  }
  return out;
}

/**
 * Derives a build config from what is on disk. Only called when the
 * directory's own pb.json has no `build` block — a partial block is used as
 * written, so removing a field is a decision the CLI does not second-guess.
 */
export function inferBuild(
  dir: string,
  kind: ResourceKind,
): Promise<BuildConfig> {
  if (kind === "frontends") return inferFrontend(dir);
  if (kind === "backends") return inferBackend(dir);
  return inferPocketBase(dir);
}

/** One human-readable line per resolved field, for the "inferred …" report. */
export function describeBuild(cfg: BuildConfig): string[] {
  const lines: string[] = [];
  const add = (k: string, v: string | undefined) =>
    v === undefined ? undefined : lines.push(`  ${k}: ${v}`);
  add("command", cfg.command);
  add("runtime", cfg.runtime);
  add("outputDir", cfg.outputDir);
  add("pb_public", cfg.pbPublic);
  add("pb_hooks", cfg.pbHooks);
  add("pb_migrations", cfg.pbMigrations);
  return lines;
}
