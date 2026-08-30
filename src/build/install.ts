import { dirname, join, resolve } from "@std/path";
import { findPackageManagerRoot } from "./detect.ts";

const DEP_FIELDS = ["dependencies", "devDependencies"] as const;

export type InstallPlan = {
  command: string;
  cwd: string;
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

async function declaredDependencies(dir: string): Promise<string[] | null> {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const field of DEP_FIELDS) {
    const deps = pkg?.[field];
    if (deps && typeof deps === "object") {
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return [...names];
}

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

export async function missingDependencies(cwd: string): Promise<string[]> {
  const declared = await declaredDependencies(cwd);
  if (!declared || await usesPnp(cwd)) return [];
  const missing: string[] = [];
  for (const name of declared) {
    if (!await resolvesFrom(cwd, name)) missing.push(name);
  }
  return missing;
}

export async function planInstall(
  cwd: string,
  command?: string,
): Promise<InstallPlan | null> {
  const missing = await missingDependencies(cwd);
  if (missing.length === 0) return null;
  if (command) return { command, cwd, missing };

  const root = await findPackageManagerRoot(cwd);
  return {
    command: `${root?.manager ?? "npm"} install`,
    cwd: root?.dir ?? cwd,
    missing,
  };
}

export function describeInstall(plan: InstallPlan): string {
  const [first, ...rest] = plan.missing;
  const why = rest.length === 0
    ? `${first} is not installed`
    : `${first} and ${rest.length} other${
      rest.length === 1 ? "" : "s"
    } are not installed`;
  return `Installing dependencies: ${plan.command} (${why})`;
}
