import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  describeInstall,
  missingDependencies,
  planInstall,
} from "../../../src/build/install.ts";

function dir(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

const pkg = (deps: Record<string, unknown>) => JSON.stringify(deps);

Deno.test("a directory with no package.json needs no install", async () => {
  assertEquals(await planInstall(dir({ "main.ts": "x" })), null);
});

Deno.test("declared dependencies that are installed need no install", async () => {
  const cwd = dir({
    "package.json": pkg({
      dependencies: { next: "15.0.0" },
      devDependencies: { typescript: "5" },
    }),
    "package-lock.json": "{}",
    "node_modules/next/package.json": "{}",
    "node_modules/typescript/package.json": "{}",
  });
  assertEquals(await planInstall(cwd), null);
});

Deno.test("a missing dependency plans the lockfile's package manager", async () => {
  const cwd = dir({
    "package.json": pkg({ dependencies: { next: "15.0.0" } }),
    "pnpm-lock.yaml": "",
  });
  const plan = await planInstall(cwd);
  assertEquals(plan?.command, "pnpm install");
  assertEquals(plan?.cwd, cwd);
  assertEquals(plan?.missing, ["next"]);
});

Deno.test("each lockfile names its own manager, npm without one", async () => {
  const cases: [string, string][] = [
    ["bun.lockb", "bun install"],
    ["bun.lock", "bun install"],
    ["yarn.lock", "yarn install"],
    ["package-lock.json", "npm install"],
  ];
  for (const [lock, command] of cases) {
    const cwd = dir({
      "package.json": pkg({ dependencies: { next: "15" } }),
      [lock]: "",
    });
    assertEquals((await planInstall(cwd))?.command, command);
  }
  const bare = dir({ "package.json": pkg({ dependencies: { next: "15" } }) });
  assertEquals((await planInstall(bare))?.command, "npm install");
});

Deno.test("devDependencies count — next is one, and the build needs it", async () => {
  const cwd = dir({
    "package.json": pkg({ devDependencies: { next: "15.0.0" } }),
  });
  assertEquals(await missingDependencies(cwd), ["next"]);
});

Deno.test("optionalDependencies never ask for a reinstall", async () => {
  const cwd = dir({
    "package.json": pkg({ optionalDependencies: { fsevents: "2" } }),
  });
  assertEquals(await missingDependencies(cwd), []);
});

Deno.test("scoped packages resolve as directories, not as one name", async () => {
  const cwd = dir({
    "package.json": pkg({ dependencies: { "@next/mdx": "15" } }),
    "node_modules/@next/mdx/package.json": "{}",
  });
  assertEquals(await missingDependencies(cwd), []);
});

Deno.test("a hoisted workspace dependency resolves from the root", async () => {
  const root = dir({
    "pnpm-lock.yaml": "",
    "node_modules/next/package.json": "{}",
    "apps/web/package.json": pkg({ dependencies: { next: "15" } }),
  });
  assertEquals(await missingDependencies(join(root, "apps", "web")), []);
});

Deno.test("a workspace install runs at the root that holds the lockfile", async () => {
  const root = dir({
    "package.json": pkg({ workspaces: ["apps/*"] }),
    "pnpm-lock.yaml": "",
    "apps/web/package.json": pkg({ dependencies: { next: "15" } }),
  });
  const plan = await planInstall(join(root, "apps", "web"));
  assertEquals(plan?.command, "pnpm install");
  assertEquals(plan?.cwd, root);
});

Deno.test("a yarn PnP project installs nothing — it has no node_modules by design", async () => {
  const cwd = dir({
    "package.json": pkg({ dependencies: { next: "15" } }),
    "yarn.lock": "",
    ".pnp.cjs": "",
  });
  assertEquals(await planInstall(cwd), null);
});

Deno.test("PnP at the workspace root covers a package below it", async () => {
  const root = dir({
    "package.json": pkg({ workspaces: ["apps/*"] }),
    "yarn.lock": "",
    ".pnp.cjs": "",
    "apps/web/package.json": pkg({ dependencies: { next: "15" } }),
  });
  assertEquals(await planInstall(join(root, "apps", "web")), null);
});

Deno.test("a lockfile with no package.json beside it is not a workspace root", async () => {
  // A stray lockfile in a parent (a home directory, say) must not turn that
  // directory into the place dependencies get installed.
  const root = dir({
    "package-lock.json": "{}",
    "app/package.json": pkg({ dependencies: { next: "15" } }),
  });
  const plan = await planInstall(join(root, "app"));
  assertEquals(plan?.cwd, join(root, "app"));
  assertEquals(plan?.command, "npm install");
});

Deno.test("an explicit install command overrides the inferred one", async () => {
  const cwd = dir({
    "package.json": pkg({ dependencies: { next: "15" } }),
    "pnpm-lock.yaml": "",
  });
  const plan = await planInstall(cwd, "make deps");
  assertEquals(plan?.command, "make deps");
  // The override belongs to this directory, so it runs here, not at the root.
  assertEquals(plan?.cwd, cwd);
});

Deno.test("an unreadable package.json installs nothing", async () => {
  const cwd = dir({ "package.json": "{ not json" });
  assertEquals(await planInstall(cwd), null);
});

Deno.test("describeInstall names the package that gave it away", () => {
  assertStringIncludes(
    describeInstall({ command: "npm install", cwd: "/x", missing: ["next"] }),
    "npm install (next is not installed)",
  );
  assertStringIncludes(
    describeInstall({ command: "npm install", cwd: "/x", missing: ["a", "b"] }),
    "(a and 1 other are not installed)",
  );
  assertStringIncludes(
    describeInstall({
      command: "npm install",
      cwd: "/x",
      missing: ["a", "b", "c"],
    }),
    "(a and 2 others are not installed)",
  );
});
