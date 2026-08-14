import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ResourceKind } from "../../../src/clients/types.ts";
import {
  detectKind,
  kindCommand,
  kindDisplay,
} from "../../../src/build/detect-kind.ts";

/** A temp directory seeded with the given relative path → contents. */
function dir(files: Record<string, string> = {}): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

const pkg = (
  o: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  },
) => JSON.stringify({ name: "x", ...o });

/** The kind alone, for the many cases where the evidence is not the point. */
async function kindOf(files: Record<string, string>): Promise<
  ResourceKind | null
> {
  return (await detectKind(dir(files)))?.kind ?? null;
}

// ===================================================================
// PocketBase
// ===================================================================

Deno.test("any one PocketBase directory identifies a PocketBase project", async () => {
  assertEquals(await kindOf({ "pb_hooks/main.pb.js": "//" }), "pocketbases");
  assertEquals(
    await kindOf({ "pb_migrations/1_init.js": "//" }),
    "pocketbases",
  );
  assertEquals(await kindOf({ "pb_public/index.html": "<p>" }), "pocketbases");
});

Deno.test("PocketBase directories outrank a package.json beside them", async () => {
  // A PocketBase project routinely carries tooling of its own — a package.json
  // for the hooks' types, a build script for pb_public.
  const guess = await detectKind(dir({
    "pb_hooks/main.pb.js": "//",
    "package.json": pkg({ scripts: { start: "node server.js" } }),
  }));
  assertEquals(guess?.kind, "pocketbases");
  assertEquals(guess?.reason, "pb_hooks/");
});

// ===================================================================
// Next.js — the one framework that is either kind
// ===================================================================

Deno.test("a Next.js project is a backend unless its config exports statically", async () => {
  assertEquals(
    await kindOf({
      "next.config.js": "module.exports = { reactStrictMode: true };",
      "package.json": pkg({ scripts: { build: "next build" } }),
    }),
    "backends",
  );
  assertEquals(
    await kindOf({
      "next.config.mjs": 'export default { output: "export" };',
      "package.json": pkg({ scripts: { build: "next build" } }),
    }),
    "frontends",
  );
});

Deno.test("a static Next.js export says which line decided it", async () => {
  const guess = await detectKind(dir({
    "next.config.ts": 'export default { output: "export" };',
  }));
  assertEquals(guess?.reason, 'next.config.ts sets output: "export"');
});

Deno.test("a Next.js config that computes output falls to the backend path", async () => {
  // Deploying it as a backend is what surfaces the real explanation:
  // ensureStandaloneOutput refuses a computed output and says what to set.
  assertEquals(
    await kindOf({
      "next.config.js":
        "module.exports = { output: process.env.EXPORT ? 'export' : undefined };",
    }),
    "backends",
  );
});

// ===================================================================
// Frontends
// ===================================================================

Deno.test("each SPA framework config identifies a frontend", async () => {
  for (
    const file of [
      "vite.config.ts",
      "vite.config.js",
      "svelte.config.js",
      "vue.config.js",
      "angular.json",
    ]
  ) {
    assertEquals(await kindOf({ [file]: "" }), "frontends", file);
  }
});

Deno.test("a multi-page generator is not claimed as a frontend by its config", async () => {
  // Frontend hosting serves one index.html with SPA fallback, so Astro and
  // Gatsby are not special-cased. Nothing is refused — the generic rules still
  // answer, and the printed reason shows which one did.
  const guess = await detectKind(dir({
    "astro.config.mjs": "",
    "package.json": pkg({ scripts: { build: "astro build" } }),
  }));
  assertEquals(guess?.kind, "frontends");
  assertEquals(guess?.reason, "a build script in package.json");
});

Deno.test("a create-react-app project is a frontend despite its start script", async () => {
  // react-scripts declares `start` (a dev server), which the generic rule
  // below would read as a backend. The dependency is checked first for exactly
  // this case.
  assertEquals(
    await kindOf({
      "package.json": pkg({
        scripts: { start: "react-scripts start", build: "react-scripts build" },
        dependencies: { "react-scripts": "5.0.1" },
      }),
      "public/index.html": "<html></html>",
    }),
    "frontends",
  );
});

Deno.test("a package.json with only a build script is a frontend", async () => {
  assertEquals(
    await kindOf({ "package.json": pkg({ scripts: { build: "tsc" } }) }),
    "frontends",
  );
});

Deno.test("a hand-written static site is a frontend wherever its index.html is", async () => {
  assertEquals(await kindOf({ "index.html": "<html></html>" }), "frontends");
  assertEquals(
    await kindOf({ "dist/index.html": "<html></html>" }),
    "frontends",
  );
  assertEquals(
    await kindOf({ "build/index.html": "<html></html>" }),
    "frontends",
  );
  assertEquals(
    await kindOf({ "out/index.html": "<html></html>" }),
    "frontends",
  );
});

// ===================================================================
// Backends
// ===================================================================

Deno.test("a Deno project is a backend", async () => {
  assertEquals(await kindOf({ "deno.json": "{}", "main.ts": "" }), "backends");
  assertEquals(await kindOf({ "deno.jsonc": "{}" }), "backends");
});

Deno.test("a server dependency identifies a backend", async () => {
  for (const dep of ["express", "fastify", "hono", "@nestjs/core"]) {
    const guess = await detectKind(dir({
      "package.json": pkg({ dependencies: { [dep]: "1.0.0" } }),
    }));
    assertEquals(guess?.kind, "backends", dep);
    assertEquals(guess?.reason, `${dep} in package.json`);
  }
});

Deno.test("a start script identifies a backend when nothing else does", async () => {
  const guess = await detectKind(dir({
    "package.json": pkg({
      scripts: { build: "tsc", start: "node dist/main.js" },
    }),
  }));
  assertEquals(guess?.kind, "backends");
  assertEquals(guess?.reason, "a start script in package.json");
});

Deno.test("a Bun server with no start script still detects as a backend", async () => {
  assertEquals(
    await kindOf({
      "bun.lock": "",
      "package.json": pkg({ dependencies: { hono: "4.0.0" } }),
      "index.ts": "",
    }),
    "backends",
  );
});

// ===================================================================
// The pb.json binding, which outranks every heuristic
// ===================================================================

Deno.test("a bound directory is never re-guessed from its files", async () => {
  // The files say backend; the binding says the platform holds a frontend.
  const guess = await detectKind(dir({
    "deno.json": "{}",
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "frontends",
      environments: { production: { id: "f1", name: "web" } },
    }),
  }));
  assertEquals(guess?.kind, "frontends");
  assertEquals(guess?.reason, "pb.json binds this directory");
});

Deno.test("a subdirectory of a bound project detects the binding above it", async () => {
  // resolveTarget walks up for the binding, so detection has to agree — or a
  // bare deploy in src/ would pick a different kind than the one it targets.
  const root = dir({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "backends",
      environments: { production: { id: "b1", name: "api" } },
    }),
    "src/index.html": "<html></html>",
  });
  assertEquals((await detectKind(join(root, "src")))?.kind, "backends");
});

Deno.test("a pb.json holding a kind but no project is still authoritative", async () => {
  // `pb cloud init frontend` records the kind before anything is deployed, so
  // readLinkFile (which requires projectId) returns nothing for it.
  const guess = await detectKind(dir({
    "deno.json": "{}",
    "pb.json": JSON.stringify({ kind: "frontends" }),
  }));
  assertEquals(guess?.kind, "frontends");
});

Deno.test("a pb.json with no kind does not stop detection", async () => {
  assertEquals(
    await kindOf({
      "pb.json": JSON.stringify({ pocketbaseVersion: "0.34.2" }),
      "vite.config.ts": "",
    }),
    "frontends",
  );
});

// ===================================================================
// No answer
// ===================================================================

Deno.test("an empty directory detects nothing rather than guessing", async () => {
  assertEquals(await detectKind(dir()), null);
});

Deno.test("a bare source tree with no manifest detects nothing", async () => {
  assertEquals(
    await kindOf({ "main.go": "package main", "README.md": "#" }),
    null,
  );
});

Deno.test("a package.json with neither script nor known dependency detects nothing", async () => {
  assertEquals(await kindOf({ "package.json": pkg({}) }), null);
});

Deno.test("an unreadable package.json is treated as absent", async () => {
  assertEquals(await kindOf({ "package.json": "{ not json" }), null);
});

// ===================================================================
// Naming
// ===================================================================

Deno.test("every kind has a label and the command group that deploys it", () => {
  assertEquals(kindDisplay("pocketbases"), "PocketBase instance");
  assertEquals(kindCommand("pocketbases"), "pb");
  assertEquals(kindDisplay("frontends"), "frontend");
  assertEquals(kindCommand("frontends"), "frontend");
  assertEquals(kindDisplay("backends"), "backend");
  assertEquals(kindCommand("backends"), "backend");
});
