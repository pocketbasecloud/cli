import { join } from "@std/path";
import type { ResourceKind } from "../clients/types.ts";
import { linkFileName, readLinkFile, readOwnLinkFile } from "../config.ts";
import { exists, findConfig } from "./detect.ts";
import { readNextOutput } from "./next-config.ts";
import { KINDS } from "../kinds.ts";

export type KindGuess = {
  kind: ResourceKind;
  reason: string;
};

export function kindDisplay(kind: ResourceKind): string {
  return KINDS[kind].display;
}

export function kindCommand(kind: ResourceKind): string {
  return KINDS[kind].noun;
}

const PB_DIRS = ["pb_hooks", "pb_migrations", "pb_public"];

const FRONTEND_CONFIG_STEMS = [
  "vite.config",
  "svelte.config",
  "vue.config",
];

const FRONTEND_CONFIG_FILES = ["angular.json"];

const SERVER_DEPS = [
  "express",
  "fastify",
  "hono",
  "koa",
  "@nestjs/core",
  "@hapi/hapi",
  "restify",
  "polka",
  "h3",
  "@trpc/server",
  "socket.io",
  "apollo-server",
  "@apollo/server",
];

const FRONTEND_DEPS = [
  "react-scripts",
  "vite",
  "@angular/core",
  "parcel",
];

const INDEX_HTML_DIRS = ["", "public", "dist", "build", "out"];

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function readPackageJson(cwd: string): Promise<PackageJson | null> {
  try {
    const parsed = JSON.parse(
      await Deno.readTextFile(join(cwd, "package.json")),
    );
    return parsed && typeof parsed === "object" ? parsed as PackageJson : null;
  } catch {
    return null;
  }
}

function dependsOn(pkg: PackageJson, names: string[]): string | undefined {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return names.find((n) => all[n] !== undefined);
}

function hasScript(pkg: PackageJson, name: string): boolean {
  const script = pkg.scripts?.[name];
  return typeof script === "string" && script.length > 0;
}

async function boundKind(cwd: string): Promise<KindGuess | null> {
  const linked = (await readLinkFile(cwd))?.kind ??
    (await readOwnLinkFile(cwd)).kind;
  return linked
    ? {
      kind: linked,
      reason: `${await linkFileName(cwd)} binds this directory`,
    }
    : null;
}

export async function detectKind(cwd: string): Promise<KindGuess | null> {
  const bound = await boundKind(cwd);
  if (bound) return bound;

  for (const dir of PB_DIRS) {
    if (await exists(join(cwd, dir))) {
      return { kind: "pocketbases", reason: `${dir}/` };
    }
  }

  const next = await readNextOutput(cwd);
  if (next) {
    return next.output === "export"
      ? { kind: "frontends", reason: `${next.file} sets output: "export"` }
      : { kind: "backends", reason: next.file };
  }

  for (const stem of FRONTEND_CONFIG_STEMS) {
    const file = await findConfig(cwd, stem);
    if (file) return { kind: "frontends", reason: file };
  }
  for (const file of FRONTEND_CONFIG_FILES) {
    if (await exists(join(cwd, file))) {
      return { kind: "frontends", reason: file };
    }
  }

  for (const file of ["deno.json", "deno.jsonc"]) {
    if (await exists(join(cwd, file))) {
      return { kind: "backends", reason: file };
    }
  }

  const pkg = await readPackageJson(cwd);
  if (pkg) {
    const server = dependsOn(pkg, SERVER_DEPS);
    if (server) {
      return { kind: "backends", reason: `${server} in package.json` };
    }
    const frontend = dependsOn(pkg, FRONTEND_DEPS);
    if (frontend) {
      return { kind: "frontends", reason: `${frontend} in package.json` };
    }
    if (hasScript(pkg, "start")) {
      return { kind: "backends", reason: "a start script in package.json" };
    }
    if (hasScript(pkg, "build")) {
      return { kind: "frontends", reason: "a build script in package.json" };
    }
  }

  for (const dir of INDEX_HTML_DIRS) {
    if (await exists(join(cwd, dir, "index.html"))) {
      return {
        kind: "frontends",
        reason: dir ? `${dir}/index.html` : "index.html",
      };
    }
  }

  return null;
}
