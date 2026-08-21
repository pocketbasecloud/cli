import { join } from "@std/path";
import type { LocalDeps } from "./deps.ts";

export const GITIGNORE_ENTRIES: readonly string[] = [
  "pocketbase",
  "pocketbase.exe",
  "pb_data/",
];

const STARTER_HOOK = `/// <reference path="../pb_data/types.d.ts" />

// PocketBase JS hooks run inside the instance. Docs:
// https://pocketbase.io/docs/js-overview/
//
// routerAdd("GET", "/hello/{name}", (e) => {
//   return e.json(200, { message: "Hello " + e.request.pathValue("name") });
// });
`;

const README = `# PocketBase project

## Start

\`\`\`sh
./pocketbase serve
\`\`\`

Then open the admin UI at <http://127.0.0.1:8090/_/>. On the very first run
PocketBase prints a one-time link for creating the superuser account. The REST
API is served from <http://127.0.0.1:8090/api/>.

Useful flags:

\`\`\`sh
./pocketbase serve --http 0.0.0.0:8090   # listen on all interfaces
./pocketbase --help                      # every subcommand
\`\`\`

### Using npm scripts

If this project already has a \`package.json\`, add a script so the usual
\`npm start\` works — no extra package is needed, the binary is already here:

\`\`\`json
{
  "scripts": {
    "start": "./pocketbase serve"
  }
}
\`\`\`

Then:

\`\`\`sh
npm start
\`\`\`

## Layout

| Path             | What it is                                              |
| ---------------- | ------------------------------------------------------- |
| \`pocketbase\`     | The server binary. Git-ignored — install it per machine. |
| \`pb_hooks/\`      | JavaScript hooks, loaded on start. Edit \`main.pb.js\`.    |
| \`pb_migrations/\` | Schema migrations, applied automatically on start.       |
| \`pb_data/\`       | Database and uploads. Git-ignored.                       |
| \`pbc.json\`        | Records the pinned PocketBase version.                   |

## Managing the binary

The binary and \`pb_data/\` are git-ignored, so a fresh clone needs the binary
installed before it can start. Using the \`pbc\` CLI:

\`\`\`sh
pbc init               # install the pinned version and scaffold
pbc install <version>  # switch to a specific version
pbc versions           # list available versions
pbc which              # show the installed binary and its pin
\`\`\`

Otherwise download it from <https://github.com/pocketbase/pocketbase/releases>
and unzip it next to this file.

## Docs

- Hooks: <https://pocketbase.io/docs/js-overview/>
- Migrations: <https://pocketbase.io/docs/js-migrations/>
`;

export type ScaffoldResult = {
  path: string;
  status: "created" | "skipped" | "updated";
};

async function exists(deps: LocalDeps, path: string): Promise<boolean> {
  return (await deps.stat(path)) !== null;
}

/**
 * Creates the directory layout PocketBase expects. Never overwrites an
 * existing file — a user's own main.pb.js is not ours to replace.
 */
export async function scaffoldProject(
  deps: LocalDeps,
  dir: string,
): Promise<ScaffoldResult[]> {
  const results: ScaffoldResult[] = [];

  const hookFile = join(dir, "pb_hooks", "main.pb.js");
  if (await exists(deps, hookFile)) {
    results.push({ path: hookFile, status: "skipped" });
  } else {
    await deps.mkdir(join(dir, "pb_hooks"));
    await deps.writeTextFile(hookFile, STARTER_HOOK);
    results.push({ path: hookFile, status: "created" });
  }

  const readme = join(dir, "README.md");
  if (await exists(deps, readme)) {
    results.push({ path: readme, status: "skipped" });
  } else {
    await deps.writeTextFile(readme, README);
    results.push({ path: readme, status: "created" });
  }

  // Check before creating — mkdir is recursive and succeeds either way.
  const migrations = join(dir, "pb_migrations");
  const hadMigrations = await exists(deps, migrations);
  await deps.mkdir(migrations);
  results.push({
    path: migrations,
    status: hadMigrations ? "skipped" : "created",
  });

  results.push(await ensureGitignore(deps, dir));
  return results;
}

async function ensureGitignore(
  deps: LocalDeps,
  dir: string,
): Promise<ScaffoldResult> {
  const path = join(dir, ".gitignore");
  let current = "";
  let existed = false;
  try {
    current = await deps.readTextFile(path);
    existed = true;
  } catch {
    // No .gitignore yet.
  }

  const present = new Set(current.split("\n").map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !present.has(e));
  if (missing.length === 0) {
    return { path, status: "skipped" };
  }

  const prefix = current.length === 0 || current.endsWith("\n")
    ? current
    : current + "\n";
  await deps.writeTextFile(path, prefix + missing.join("\n") + "\n");
  return { path, status: existed ? "updated" : "created" };
}
