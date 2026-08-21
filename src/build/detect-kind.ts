import { join } from "@std/path";
import type { ResourceKind } from "../clients/types.ts";
import { linkFileName, readLinkFile, readOwnLinkFile } from "../config.ts";
import { exists, findConfig } from "./detect.ts";
import { readNextOutput } from "./next-config.ts";

/**
 * Which of the three things a directory is, and the evidence for it.
 *
 * `detect.ts` answers "how do I build this?" once the kind is known; this
 * answers the question before it — the one `pbc cloud deploy` exists to stop
 * asking the user. The evidence travels with the answer because a guess the
 * user cannot check is worse than no guess: one line naming the file that
 * decided it turns a wrong detection into an obvious wrong detection.
 */
export type KindGuess = {
  kind: ResourceKind;
  /** Short noun phrase, printed in parentheses, e.g. `vite.config.ts`. */
  reason: string;
};

/** How each kind is named to a user, and which command group deploys it. */
const KINDS: Record<ResourceKind, { label: string; command: string }> = {
  pocketbases: { label: "PocketBase instance", command: "pb" },
  frontends: { label: "frontend", command: "frontend" },
  backends: { label: "backend", command: "backend" },
};

export function kindDisplay(kind: ResourceKind): string {
  return KINDS[kind].label;
}

export function kindCommand(kind: ResourceKind): string {
  return KINDS[kind].command;
}

/** The directories a PocketBase project ships, any one of which settles it. */
const PB_DIRS = ["pb_hooks", "pb_migrations", "pb_public"];

/**
 * Config files whose presence means a static site. Each is a *stem*, so any
 * extension matches — `vite.config.ts` and `vite.config.js` both count.
 *
 * Deliberately the same set `inferFrontend` knows how to build, and no wider.
 * Two kinds of framework are left out on purpose:
 *
 * - Ones that can render on a server (Nuxt, SvelteKit's node adapter).
 *   Guessing "frontend" would deploy a server as a pile of files.
 * - Multi-page generators (Astro, Gatsby, Eleventy). Frontend hosting serves a
 *   single `index.html` with SPA fallback, so naming them here would be the
 *   CLI claiming support the platform does not have.
 *
 * Neither is refused — they fall through to the generic package.json rules
 * below, and `pbc cloud deploy frontend` settles any case those get wrong.
 */
const FRONTEND_CONFIG_STEMS = [
  "vite.config",
  "svelte.config",
  "vue.config",
];

/** Frontend markers that are a fixed filename rather than a stem. */
const FRONTEND_CONFIG_FILES = ["angular.json"];

/** A dependency on one of these means the directory serves requests. */
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

/** A dependency on one of these means the directory builds a static bundle. */
const FRONTEND_DEPS = [
  "react-scripts",
  "vite",
  "@angular/core",
  "parcel",
];

/** Where a built or hand-written static site keeps its entry document. */
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

/**
 * The kind this directory is already bound to, which outranks every heuristic
 * below: `kind` is written by the deploy that created the resource, so it is a
 * record of what the platform holds rather than a guess about the files.
 *
 * Walks up the way `readLinkFile` does, so a subdirectory of a linked project
 * detects the same kind its deploy would target. A pbc.json with a `kind` but
 * no `projectId` — hand-written, or written by an older `init` — is read too,
 * since the answer it gives is just as good.
 */
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

/**
 * What `pbc cloud deploy` should deploy, or null when the directory says
 * nothing either way.
 *
 * Ordered by how much the evidence proves, strongest first, and every rule is
 * a file that exists rather than one that does not — "no package.json" is true
 * of an empty directory too. The frontend/backend split is the only genuinely
 * hard call, and it is made three times over: by framework config, by
 * dependency, and finally by whether the project declares a way to *start*
 * (a server) or only a way to *build* (a bundle).
 */
export async function detectKind(cwd: string): Promise<KindGuess | null> {
  const bound = await boundKind(cwd);
  if (bound) return bound;

  for (const dir of PB_DIRS) {
    if (await exists(join(cwd, dir))) {
      return { kind: "pocketbases", reason: `${dir}/` };
    }
  }

  // Next.js is the one framework that is either kind, and its own config says
  // which: `output: "export"` writes a static site, anything else runs a
  // server. A config that computes the value is left to the backend path,
  // where `ensureStandaloneOutput` already explains what to do about it.
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
    // A project that can be started is a server; one that can only be built is
    // a bundle. Checked in that order because a static site rarely declares a
    // start script, while a backend routinely declares both.
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
