import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { detectPackageManager, inferBuild } from "../../../src/build/detect.ts";

function dir(files: Record<string, string> = {}): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

const pkg = (scripts: Record<string, string> = {}) =>
  JSON.stringify({ name: "x", scripts });

Deno.test("detectPackageManager prefers bun, then pnpm, then yarn, else npm", async () => {
  assertEquals(await detectPackageManager(dir()), "npm");
  assertEquals(await detectPackageManager(dir({ "yarn.lock": "" })), "yarn");
  assertEquals(
    await detectPackageManager(dir({ "pnpm-lock.yaml": "" })),
    "pnpm",
  );
  assertEquals(
    await detectPackageManager(
      dir({ "bun.lockb": "", "pnpm-lock.yaml": "", "yarn.lock": "" }),
    ),
    "bun",
  );
});

Deno.test("frontend inference maps each framework to its output directory", async () => {
  const cases: [Record<string, string>, string][] = [
    [
      { "vite.config.ts": "", "package.json": pkg({ build: "vite build" }) },
      "dist",
    ],
    [
      { "svelte.config.js": "", "package.json": pkg({ build: "vite build" }) },
      "build",
    ],
    [
      { "angular.json": "", "package.json": pkg({ build: "ng build" }) },
      "dist",
    ],
    [
      { "next.config.js": "", "package.json": pkg({ build: "next build" }) },
      "out",
    ],
  ];
  for (const [files, expected] of cases) {
    const cfg = await inferBuild(dir(files), "frontends");
    assertEquals(cfg.outputDir, expected);
    assertEquals(cfg.command, "npm run build");
  }
});

Deno.test("frontend inference picks an existing dist/build/out with no framework config", async () => {
  const root = dir({ "package.json": pkg({ build: "make" }) });
  Deno.mkdirSync(join(root, "build"));
  assertEquals((await inferBuild(root, "frontends")).outputDir, "build");
});

Deno.test("frontend inference yields no command when package.json has no build script", async () => {
  const cfg = await inferBuild(dir({ "package.json": pkg() }), "frontends");
  assertEquals(cfg.command, undefined);
  assertEquals(cfg.outputDir, ".");
});

Deno.test("frontend inference uses the detected package manager", async () => {
  const cfg = await inferBuild(
    dir({
      "vite.config.js": "",
      "yarn.lock": "",
      "package.json": pkg({ build: "vite build" }),
    }),
    "frontends",
  );
  assertEquals(cfg.command, "yarn run build");
});

Deno.test("backend inference maps manifests to runtimes", async () => {
  assertEquals(
    (await inferBuild(dir({ "deno.json": "{}" }), "backends")).runtime,
    "deno",
  );
  assertEquals(
    (await inferBuild(dir({ "deno.jsonc": "{}" }), "backends")).runtime,
    "deno",
  );
  assertEquals(
    (await inferBuild(dir({ "bun.lockb": "" }), "backends")).runtime,
    "bun",
  );
  assertEquals(
    (await inferBuild(dir({ "package.json": pkg() }), "backends")).runtime,
    "nodejs",
  );
});

Deno.test("backend inference detects nextjs and keeps its build command", async () => {
  const cfg = await inferBuild(
    dir({
      "next.config.mjs": "",
      "package.json": pkg({ build: "next build" }),
    }),
    "backends",
  );
  assertEquals(cfg.runtime, "nextjs");
  assertEquals(cfg.command, "npm run build");
  assertEquals(cfg.outputDir, undefined);
});

Deno.test("backend inference beats deno.json with next.config", async () => {
  const cfg = await inferBuild(
    dir({ "next.config.ts": "", "deno.json": "{}" }),
    "backends",
  );
  assertEquals(cfg.runtime, "nextjs");
});

Deno.test("backend inference falls back to shipping the directory as-is", async () => {
  const cfg = await inferBuild(dir(), "backends");
  assertEquals(cfg.runtime, undefined);
  assertEquals(cfg.outputDir, ".");
});

Deno.test("pocketbase inference records only the directories that exist", async () => {
  const root = dir({ "pb_hooks/main.pb.js": "//" });
  Deno.mkdirSync(join(root, "pb_migrations"));
  const cfg = await inferBuild(root, "pocketbases");
  assertEquals(cfg.pbHooks, "pb_hooks");
  assertEquals(cfg.pbMigrations, "pb_migrations");
  assertEquals(cfg.pbPublic, undefined);
});

Deno.test("pocketbase inference yields an empty config when none of the three exist", async () => {
  const cfg = await inferBuild(dir(), "pocketbases");
  assertEquals(cfg.pbPublic, undefined);
  assertEquals(cfg.pbHooks, undefined);
  assertEquals(cfg.pbMigrations, undefined);
});

Deno.test("backend inference reads the project's own start task/script", async () => {
  assertEquals(
    (await inferBuild(
      dir({
        "deno.json": JSON.stringify({ tasks: { start: "deno run -A m.ts" } }),
      }),
      "backends",
    )).startCommand,
    "deno task start",
  );
  assertEquals(
    (await inferBuild(
      dir({ "package.json": pkg({ start: "node s.js" }) }),
      "backends",
    ))
      .startCommand,
    "npm run start",
  );
  assertEquals(
    (await inferBuild(
      dir({ "package.json": pkg({ start: "bun s.ts" }), "bun.lockb": "" }),
      "backends",
    )).startCommand,
    "bun run start",
  );
});

Deno.test("backend inference leaves startCommand unset when nothing declares one", async () => {
  assertEquals(
    (await inferBuild(dir({ "deno.json": "{}" }), "backends")).startCommand,
    undefined,
  );
  assertEquals(
    (await inferBuild(dir({ "package.json": pkg() }), "backends")).startCommand,
    undefined,
  );
});
