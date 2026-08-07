import { dirname, join, resolve } from "@std/path";
import { findPackageManagerRoot } from "./detect.ts";

/**
 * Installing dependencies before the build.
 *
 * A build command is the project's own (`npm run build`, `next build`, …), so
 * it only works once `node_modules` is populated. A fresh clone, a CI runner
 * with no cache, or a dependency added to package.json but never installed all
 * produce the same thing: `sh: next: not found`, exit 127, and a deploy that
 * failed for a reason that has nothing to do with the platform. Next.js feels
 * it most, since its bundle is built locally and never on the host.
 *
 * So the CLI installs them itself when — and only when — something declared in
 * package.json is not resolvable. Never on a project whose dependencies are
 * already there: `npm install` on a warm tree is still seconds of network per
 * deploy, and re-resolving a lockfile nobody asked to change is not the CLI's
 * business.
 */

/** Fields whose entries must resolve for a build to run. */
const DEP_FIELDS = ["dependencies", "devDependencies"] as const;

export type InstallPlan = {
  /** Shell command to run. */
  command: string;
  /** Where to run it — the workspace root when the project is one. */
  cwd: string;
  /** Declared packages that did not resolve, in package.json order. */
  missing: string[];
};

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Declared runtime + dev dependency names, or null when there is no manifest. */
async function declaredDependencies(dir: string): Promise<string[] | null> {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
  } catch {
    // No package.json, or one this cannot read: nothing to conclude, so
    // nothing is installed. A malformed manifest is the build's error to
    // report, with its own far better message.
    return null;
  }
  const names = new Set<string>();
  for (const field of DEP_FIELDS) {
    const deps = pkg?.[field];
    if (deps && typeof deps === "object") {
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  // optionalDependencies are deliberately absent: one that legitimately did not
  // install (a platform-specific binary) would ask for a reinstall every deploy.
  return [...names];
}

/**
 * Node's own resolution, narrowed to the directory lookup: `node_modules` in
 * `startDir`, then in each ancestor. Hoisting means a workspace package's
 * dependencies usually live in the root's `node_modules`, and reporting those
 * as missing would install into the wrong place.
 */
async function resolvesFrom(startDir: string, name: string): Promise<boolean> {
  let dir = resolve(startDir);
  while (true) {
    if (await exists(join(dir, "node_modules", ...name.split("/")))) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Yarn Plug'n'Play resolves out of a zip index instead of `node_modules`, so an
 * absent `node_modules` there proves nothing and reinstalling every deploy
 * would be the only result.
 */
async function usesPnp(cwd: string): Promise<boolean> {
  let dir = resolve(cwd);
  while (true) {
    for (const name of [".pnp.cjs", ".pnp.js"]) {
      if (await exists(join(dir, name))) return true;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Declared dependencies that are not installed anywhere Node would look. */
export async function missingDependencies(cwd: string): Promise<string[]> {
  const declared = await declaredDependencies(cwd);
  if (!declared || await usesPnp(cwd)) return [];
  const missing: string[] = [];
  for (const name of declared) {
    if (!await resolvesFrom(cwd, name)) missing.push(name);
  }
  return missing;
}

/**
 * The install to run before the build, or null when every declared dependency
 * already resolves. `command` overrides the inferred one (pb.json's
 * `build.install`) and still runs only when something is missing.
 */
export async function planInstall(
  cwd: string,
  command?: string,
): Promise<InstallPlan | null> {
  const missing = await missingDependencies(cwd);
  if (missing.length === 0) return null;
  if (command) return { command, cwd, missing };

  const root = await findPackageManagerRoot(cwd);
  // No lockfile anywhere: npm is the one manager guaranteed to be on the
  // machine, and it writes the lockfile the next deploy will read.
  return {
    command: `${root?.manager ?? "npm"} install`,
    cwd: root?.dir ?? cwd,
    missing,
  };
}

/** The line the deploy prints before running an install. */
export function describeInstall(plan: InstallPlan): string {
  const [first, ...rest] = plan.missing;
  const why = rest.length === 0
    ? `${first} is not installed`
    : `${first} and ${rest.length} other${
      rest.length === 1 ? "" : "s"
    } are not installed`;
  return `Installing dependencies: ${plan.command} (${why})`;
}
