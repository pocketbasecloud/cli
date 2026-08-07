import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  formatSize,
  packageResource,
  strategyFor,
} from "../../../src/build/package.ts";
import { extractEntry } from "../../../src/local/unzip.ts";
import { CliError } from "../../../src/errors.ts";
import type { BuildConfig } from "../../../src/config.ts";

function dir(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

const noop = () => {};

/** Entry names in the produced archive, sorted for stable comparison. */
async function names(
  cwd: string,
  kind: "frontends" | "backends" | "pocketbases",
  build: BuildConfig,
): Promise<string[]> {
  const { bytes } = await packageResource({
    cwd,
    kind,
    build,
    skipBuild: true,
    log: noop,
  });
  return listNames(bytes).sort();
}

/** Reads entry names straight out of the central directory. */
function listNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    out.push(dec.decode(zip.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

Deno.test("strategyFor maps kind and runtime to a strategy", () => {
  assertEquals(strategyFor("frontends", undefined), "static");
  assertEquals(strategyFor("pocketbases", undefined), "pbdirs");
  assertEquals(strategyFor("backends", "deno"), "source");
  assertEquals(strategyFor("backends", "nodejs"), "source");
  assertEquals(strategyFor("backends", "nextjs"), "standalone");
});

Deno.test("static ships the output directory's contents at the zip root", async () => {
  const cwd = dir({
    "dist/index.html": "<h1>hi</h1>",
    "dist/assets/app.js": "1",
    "src/main.ts": "not shipped",
  });
  assertEquals(await names(cwd, "frontends", { outputDir: "dist" }), [
    "assets/app.js",
    "index.html",
  ]);
});

Deno.test("static defaults outputDir to dist", async () => {
  const cwd = dir({ "dist/index.html": "x" });
  assertEquals(await names(cwd, "frontends", {}), ["index.html"]);
});

Deno.test("static errors when the output directory is missing", async () => {
  await assertRejects(
    () => names(dir({ "src/a.ts": "x" }), "frontends", { outputDir: "dist" }),
    CliError,
    "Build output dist not found",
  );
});

Deno.test("source ships the directory and drops node_modules", async () => {
  const cwd = dir({
    "main.ts": "x",
    "deno.json": "{}",
    "node_modules/dep/index.js": "x",
  });
  assertEquals(await names(cwd, "backends", { runtime: "deno" }), [
    "deno.json",
    "main.ts",
  ]);
});

Deno.test("the denylist drops .git, pb_data, dotenv files, and logs", async () => {
  const cwd = dir({
    "dist/index.html": "x",
    "dist/.env": "SECRET=1",
    "dist/.env.production": "SECRET=1",
    "dist/debug.log": "noise",
    "dist/.git/config": "x",
    "dist/pb_data/data.db": "x",
  });
  assertEquals(await names(cwd, "frontends", { outputDir: "dist" }), [
    "index.html",
  ]);
});

Deno.test("build.exclude globs drop extra files", async () => {
  const cwd = dir({
    "dist/app.js": "x",
    "dist/app.js.map": "x",
    "dist/nested/deep.js.map": "x",
  });
  assertEquals(
    await names(cwd, "frontends", {
      outputDir: "dist",
      exclude: ["**/*.map"],
    }),
    ["app.js"],
  );
});

Deno.test("standalone assembles the bundle and keeps its node_modules", async () => {
  const cwd = dir({
    ".next/standalone/server.js": "require('./x')",
    ".next/standalone/node_modules/next/index.js": "x",
    ".next/static/chunk.js": "x",
    "public/logo.svg": "<svg/>",
    "src/page.tsx": "not shipped",
  });
  assertEquals(await names(cwd, "backends", { runtime: "nextjs" }), [
    ".next/static/chunk.js",
    "node_modules/next/index.js",
    "public/logo.svg",
    "server.js",
  ]);
});

Deno.test("standalone works without a public directory", async () => {
  const cwd = dir({
    ".next/standalone/server.js": "x",
    ".next/static/chunk.js": "x",
  });
  assertEquals(await names(cwd, "backends", { runtime: "nextjs" }), [
    ".next/static/chunk.js",
    "server.js",
  ]);
});

Deno.test("standalone reports the missing bundle in terms of next.config", async () => {
  await assertRejects(
    () =>
      names(dir({ "src/page.tsx": "x" }), "backends", { runtime: "nextjs" }),
    CliError,
    'output: "standalone"',
  );
});

Deno.test("standalone errors when server.js is not at the bundle root", async () => {
  const cwd = dir({ ".next/standalone/apps/web/server.js": "x" });
  await assertRejects(
    () => names(cwd, "backends", { runtime: "nextjs" }),
    CliError,
    "No server.js at the root",
  );
});

Deno.test("standalone reports its start command", async () => {
  const cwd = dir({ ".next/standalone/server.js": "x" });
  const packed = await packageResource({
    cwd,
    kind: "backends",
    build: { runtime: "nextjs" },
    skipBuild: true,
    log: noop,
  });
  assertEquals(packed.startCommand, "node server.js");
  assertEquals(packed.fileName, "code.zip");
});

Deno.test("pbdirs stages each directory under its canonical name", async () => {
  const cwd = dir({
    "site/index.html": "x",
    "hooks/main.pb.js": "x",
    "pb_migrations/1_init.js": "x",
  });
  assertEquals(
    await names(cwd, "pocketbases", {
      pbPublic: "site",
      pbHooks: "hooks",
      pbMigrations: "pb_migrations",
    }),
    ["pb_hooks/main.pb.js", "pb_migrations/1_init.js", "pb_public/index.html"],
  );
});

Deno.test("pbdirs skips directories the config does not name", async () => {
  const cwd = dir({ "pb_hooks/main.pb.js": "x", "pb_public/i.html": "x" });
  assertEquals(await names(cwd, "pocketbases", { pbHooks: "pb_hooks" }), [
    "pb_hooks/main.pb.js",
  ]);
});

Deno.test("pbdirs names the pb.json field when a directory is missing", async () => {
  await assertRejects(
    () => names(dir({ "a.txt": "x" }), "pocketbases", { pbHooks: "hooks" }),
    CliError,
    "build.pbHooks",
  );
});

Deno.test("pocketbase archives are named data.zip", async () => {
  const cwd = dir({ "pb_hooks/main.pb.js": "x" });
  const packed = await packageResource({
    cwd,
    kind: "pocketbases",
    build: { pbHooks: "pb_hooks" },
    skipBuild: true,
    log: noop,
  });
  assertEquals(packed.fileName, "data.zip");
});

Deno.test("pbdirs with no directories configured packages an empty archive rather than erroring", async () => {
  const cwd = Deno.makeTempDirSync();
  assertEquals(await names(cwd, "pocketbases", {}), []);
});

Deno.test("an empty package is refused rather than uploaded", async () => {
  const cwd = Deno.makeTempDirSync();
  Deno.mkdirSync(join(cwd, "dist"));
  await assertRejects(
    () => names(cwd, "frontends", { outputDir: "dist" }),
    CliError,
    "Nothing to deploy",
  );
});

Deno.test("the build command runs in the resource directory before packaging", async () => {
  const cwd = dir({ "dist/index.html": "x" });
  const calls: [string, string][] = [];
  await packageResource({
    cwd,
    kind: "frontends",
    build: { command: "npm run build", outputDir: "dist" },
    skipBuild: false,
    log: noop,
    run: (command, at) => {
      calls.push([command, at]);
      return Promise.resolve({ code: 0 });
    },
  });
  assertEquals(calls, [["npm run build", cwd]]);
});

Deno.test("dependencies are installed before the build that needs them", async () => {
  const cwd = dir({
    "package.json": JSON.stringify({ dependencies: { next: "15" } }),
    "package-lock.json": "{}",
    "dist/index.html": "x",
  });
  const calls: [string, string][] = [];
  const messages: string[] = [];
  await packageResource({
    cwd,
    kind: "frontends",
    build: { command: "npm run build", outputDir: "dist" },
    skipBuild: false,
    log: (m) => messages.push(m),
    run: (command, at) => {
      calls.push([command, at]);
      return Promise.resolve({ code: 0 });
    },
  });
  assertEquals(calls, [["npm install", cwd], ["npm run build", cwd]]);
  assertStringIncludes(messages[0], "Installing dependencies: npm install");
});

Deno.test("an installed tree is not reinstalled", async () => {
  const cwd = dir({
    "package.json": JSON.stringify({ dependencies: { next: "15" } }),
    "node_modules/next/package.json": "{}",
    "dist/index.html": "x",
  });
  const calls: string[] = [];
  await packageResource({
    cwd,
    kind: "frontends",
    build: { command: "npm run build", outputDir: "dist" },
    skipBuild: false,
    log: noop,
    run: (command) => {
      calls.push(command);
      return Promise.resolve({ code: 0 });
    },
  });
  assertEquals(calls, ["npm run build"]);
});

Deno.test('install: "" opts out of the install step', async () => {
  const cwd = dir({
    "package.json": JSON.stringify({ dependencies: { next: "15" } }),
    "dist/index.html": "x",
  });
  const calls: string[] = [];
  await packageResource({
    cwd,
    kind: "frontends",
    build: { command: "npm run build", outputDir: "dist", install: "" },
    skipBuild: false,
    log: noop,
    run: (command) => {
      calls.push(command);
      return Promise.resolve({ code: 0 });
    },
  });
  assertEquals(calls, ["npm run build"]);
});

Deno.test("--skip-build installs nothing either", async () => {
  const cwd = dir({
    "package.json": JSON.stringify({ dependencies: { next: "15" } }),
    "dist/index.html": "x",
  });
  let ran = false;
  await packageResource({
    cwd,
    kind: "frontends",
    build: { command: "npm run build", outputDir: "dist" },
    skipBuild: true,
    log: noop,
    run: () => {
      ran = true;
      return Promise.resolve({ code: 0 });
    },
  });
  assertEquals(ran, false);
});

Deno.test("a failing install exits 7 and never starts the build", async () => {
  const cwd = dir({
    "package.json": JSON.stringify({ dependencies: { next: "15" } }),
    "dist/index.html": "x",
  });
  const calls: string[] = [];
  const err = await assertRejects(
    () =>
      packageResource({
        cwd,
        kind: "frontends",
        build: { command: "npm run build", outputDir: "dist" },
        skipBuild: false,
        log: noop,
        run: (command) => {
          calls.push(command);
          return Promise.resolve({ code: 1 });
        },
      }),
    CliError,
    "Installing dependencies failed",
  );
  assertEquals(err.exitCode, 7);
  assertEquals(calls, ["npm install"]);
});

Deno.test("a failing build exits 7 and produces no archive", async () => {
  const cwd = dir({ "dist/index.html": "x" });
  const err = await assertRejects(
    () =>
      packageResource({
        cwd,
        kind: "frontends",
        build: { command: "exit 1", outputDir: "dist" },
        skipBuild: false,
        log: noop,
        run: () => Promise.resolve({ code: 1 }),
      }),
    CliError,
    "Build failed",
  );
  assertEquals(err.exitCode, 7);
});

Deno.test("--skip-build packages without running the command", async () => {
  const cwd = dir({ "dist/index.html": "x" });
  let ran = false;
  await packageResource({
    cwd,
    kind: "frontends",
    build: { command: "npm run build", outputDir: "dist" },
    skipBuild: true,
    log: noop,
    run: () => {
      ran = true;
      return Promise.resolve({ code: 0 });
    },
  });
  assertEquals(ran, false);
});

Deno.test("a nextjs build gets output: standalone before it runs", async () => {
  const cwd = dir({
    "next.config.mjs": "const nextConfig = {};\nexport default nextConfig;\n",
    ".next/standalone/server.js": "x",
  });
  const seen: string[] = [];
  const messages: string[] = [];
  await packageResource({
    cwd,
    kind: "backends",
    build: { command: "npm run build", runtime: "nextjs" },
    skipBuild: false,
    log: (m) => messages.push(m),
    // Read at build time: the config must already say standalone by now,
    // otherwise the build produces a bundle that cannot be packaged.
    run: () => {
      seen.push(Deno.readTextFileSync(join(cwd, "next.config.mjs")));
      return Promise.resolve({ code: 0 });
    },
  });
  assertEquals(seen.length, 1);
  assertStringIncludes(seen[0], `output: "standalone"`);
  assertStringIncludes(messages[0], `Added output: "standalone"`);
});

Deno.test("a nextjs deploy installs next before building the bundle", async () => {
  const cwd = dir({
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }),
    "next.config.mjs": `export default { output: "standalone" };\n`,
    ".next/standalone/server.js": "x",
  });
  const calls: string[] = [];
  await packageResource({
    cwd,
    kind: "backends",
    build: { command: "npm run build", runtime: "nextjs" },
    skipBuild: false,
    log: noop,
    run: (command) => {
      calls.push(command);
      return Promise.resolve({ code: 0 });
    },
  });
  assertEquals(calls, ["npm install", "npm run build"]);
});

Deno.test("--skip-build leaves next.config alone", async () => {
  const body = "export default {};\n";
  const cwd = dir({
    "next.config.js": body,
    ".next/standalone/server.js": "x",
  });
  await packageResource({
    cwd,
    kind: "backends",
    build: { command: "npm run build", runtime: "nextjs" },
    skipBuild: true,
    log: noop,
  });
  assertEquals(await Deno.readTextFile(join(cwd, "next.config.js")), body);
});

Deno.test("a non-nextjs backend's config is never touched", async () => {
  const body = "export default {};\n";
  const cwd = dir({ "next.config.js": body, "server.ts": "x" });
  await packageResource({
    cwd,
    kind: "backends",
    build: { command: "deno task build", runtime: "deno", outputDir: "." },
    skipBuild: false,
    log: noop,
    run: () => Promise.resolve({ code: 0 }),
  });
  assertEquals(await Deno.readTextFile(join(cwd, "next.config.js")), body);
});

Deno.test("packaged entries are readable back out of the archive", async () => {
  const cwd = dir({ "dist/index.html": "<h1>hi</h1>" });
  const { bytes } = await packageResource({
    cwd,
    kind: "frontends",
    build: { outputDir: "dist" },
    skipBuild: true,
    log: noop,
  });
  assertEquals(
    new TextDecoder().decode(await extractEntry(bytes, "index.html")),
    "<h1>hi</h1>",
  );
});

Deno.test("formatSize scales to B, KB, and MB", () => {
  assertEquals(formatSize(512), "512 B");
  assertEquals(formatSize(2048), "2.0 KB");
  assertEquals(formatSize(3 * 1024 * 1024), "3.0 MB");
});
