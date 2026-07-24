import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { envFileOf, resolveBuildConfig } from "../../../src/build/config.ts";
import { readOwnPbJson } from "../../../src/config.ts";

const noop = () => {};

function seed(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

Deno.test("an inferred block is reported and written back to pb.json", async () => {
  const cwd = seed({
    "vite.config.ts": "",
    "package.json": '{"scripts":{"build":"vite build"}}',
  });
  const lines: string[] = [];
  const cfg = await resolveBuildConfig({
    cwd,
    kind: "frontends",
    flags: {},
    log: (m) => lines.push(m),
  });
  assertEquals(cfg.outputDir, "dist");
  assertEquals((await readOwnPbJson(cwd)).build?.outputDir, "dist");
  assertEquals(lines.some((l) => l.includes("inferred")), true);
});

Deno.test("an existing block suppresses inference entirely", async () => {
  // vite.config would infer dist; the recorded block must win untouched.
  const cwd = seed({
    "vite.config.ts": "",
    "pb.json": JSON.stringify({
      projectId: "p1",
      build: { outputDir: "public" },
    }),
  });
  const cfg = await resolveBuildConfig({
    cwd,
    kind: "frontends",
    flags: {},
    log: noop,
  });
  assertEquals(cfg.outputDir, "public");
  // A deliberately removed command is not re-inferred.
  assertEquals(cfg.command, undefined);
});

Deno.test("persisting an inferred block preserves the rest of pb.json", async () => {
  const cwd = seed({
    "deno.json": "{}",
    "pb.json": JSON.stringify({
      projectId: "p1",
      pocketbaseVersion: "0.34.2",
      kind: "backends",
      environments: { production: { id: "b1", name: "api" } },
    }),
  });
  await resolveBuildConfig({ cwd, kind: "backends", flags: {}, log: noop });
  const own = await readOwnPbJson(cwd);
  assertEquals(own.projectId, "p1");
  assertEquals(own.pocketbaseVersion, "0.34.2");
  assertEquals(own.environments?.production.id, "b1");
  assertEquals(own.build?.runtime, "deno");
});

Deno.test("flags override the recorded block without rewriting it", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      build: { runtime: "nodejs", envFile: ".env" },
    }),
  });
  const cfg = await resolveBuildConfig({
    cwd,
    kind: "backends",
    flags: { runtime: "bun", envFile: ".env.production" },
    log: noop,
  });
  assertEquals(cfg.runtime, "bun");
  assertEquals(cfg.envFile, ".env.production");
  // The file still says what the user wrote.
  const own = await readOwnPbJson(cwd);
  assertEquals(own.build?.runtime, "nodejs");
  assertEquals(own.build?.envFile, ".env");
});

Deno.test("build config comes from the cwd's own pb.json, never a parent's", async () => {
  const parent = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      build: { outputDir: "parent-dist" },
    }),
  });
  const child = join(parent, "web");
  Deno.mkdirSync(child);
  Deno.writeTextFileSync(join(child, "vite.config.ts"), "");
  const cfg = await resolveBuildConfig({
    cwd: child,
    kind: "frontends",
    flags: {},
    log: noop,
  });
  assertEquals(cfg.outputDir, "dist");
});

Deno.test("envFileOf defaults to .env", () => {
  assertEquals(envFileOf({}), ".env");
  assertEquals(envFileOf({ envFile: ".env.production" }), ".env.production");
});

Deno.test("an environment's build overrides the base block key by key", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "frontends",
      build: { command: "npm run build", outputDir: "dist" },
      environments: {
        staging: {
          id: "fe2",
          name: "web-staging",
          build: { command: "npm run build:staging" },
        },
      },
    }),
  });
  const cfg = await resolveBuildConfig({
    cwd,
    kind: "frontends",
    flags: {},
    environment: "staging",
    log: noop,
  });
  assertEquals(cfg.command, "npm run build:staging");
  // Keys the environment leaves alone still come from the base.
  assertEquals(cfg.outputDir, "dist");
});

Deno.test("another environment's overrides do not leak into this one", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "frontends",
      build: { command: "npm run build", outputDir: "dist" },
      environments: {
        staging: { id: "fe2", name: "s", build: { command: "other" } },
      },
    }),
  });
  const cfg = await resolveBuildConfig({
    cwd,
    kind: "frontends",
    flags: {},
    environment: "production",
    log: noop,
  });
  assertEquals(cfg.command, "npm run build");
});

Deno.test("an environment's exclude replaces the base list rather than appending", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "frontends",
      build: { outputDir: "dist", exclude: ["*.map", "docs"] },
      environments: {
        staging: { id: "fe2", name: "s", build: { exclude: ["*.map"] } },
      },
    }),
  });
  const cfg = await resolveBuildConfig({
    cwd,
    kind: "frontends",
    flags: {},
    environment: "staging",
    log: noop,
  });
  assertEquals(cfg.exclude, ["*.map"]);
});

Deno.test("flags still beat an environment's block", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "backends",
      build: { runtime: "nodejs", envFile: ".env" },
      environments: {
        staging: {
          id: "be2",
          name: "api-staging",
          build: { runtime: "deno", envFile: ".env.staging" },
        },
      },
    }),
  });
  const cfg = await resolveBuildConfig({
    cwd,
    kind: "backends",
    flags: { runtime: "bun", envFile: ".env.ci" },
    environment: "staging",
    log: noop,
  });
  assertEquals(cfg.runtime, "bun");
  assertEquals(cfg.envFile, ".env.ci");
  // The file is left as written; flags apply to this run only.
  const own = await readOwnPbJson(cwd);
  assertEquals(own.build?.runtime, "nodejs");
  assertEquals(own.environments?.staging.build?.runtime, "deno");
});

Deno.test("an environment-only build block suppresses inference", async () => {
  // vite.config would infer dist; a block anywhere means the user has decided.
  const cwd = seed({
    "vite.config.ts": "",
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "frontends",
      environments: {
        staging: { id: "fe2", name: "s", build: { outputDir: "build" } },
      },
    }),
  });
  const cfg = await resolveBuildConfig({
    cwd,
    kind: "frontends",
    flags: {},
    environment: "staging",
    log: noop,
  });
  assertEquals(cfg.outputDir, "build");
  assertEquals((await readOwnPbJson(cwd)).build, undefined);
});

Deno.test("an inferred block is written to the base, not to the environment", async () => {
  // Inference reads the directory, which is the same in every environment.
  const cwd = seed({
    "vite.config.ts": "",
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "frontends",
      environments: { staging: { id: "fe2", name: "s" } },
    }),
  });
  await resolveBuildConfig({
    cwd,
    kind: "frontends",
    flags: {},
    environment: "staging",
    log: noop,
  });
  const own = await readOwnPbJson(cwd);
  assertEquals(own.build?.outputDir, "dist");
  assertEquals(own.environments?.staging.build, undefined);
});
