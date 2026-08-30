import { assertEquals } from "@std/assert";
import { scaffoldProject } from "../../../src/local/scaffold.ts";
import type { LocalDeps } from "../../../src/local/deps.ts";

function harness(initial: Record<string, string> = {}) {
  const texts = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
  const deps: LocalDeps = {
    fetch:
      (() =>
        Promise.reject(new Error("no network"))) as unknown as typeof fetch,
    cwd: () => "/work",
    readTextFile: (p) => {
      const t = texts.get(p);
      return t === undefined
        ? Promise.reject(new Deno.errors.NotFound(p))
        : Promise.resolve(t);
    },
    writeFile: () => Promise.resolve(),
    writeTextFile: (p, d) => {
      texts.set(p, d);
      return Promise.resolve();
    },
    mkdir: (p) => {
      dirs.add(p);
      return Promise.resolve();
    },
    rename: () => Promise.resolve(),
    chmod: () => Promise.resolve(),
    stat: (p) =>
      Promise.resolve(
        texts.has(p)
          ? { isFile: true }
          : dirs.has(p)
          ? { isFile: false }
          : null,
      ),
    remove: () => Promise.resolve(),
    env: () => undefined,
  };
  return { deps, texts, dirs };
}

function statusOf(results: { path: string; status: string }[], suffix: string) {
  return results.find((r) => r.path.endsWith(suffix))?.status;
}

Deno.test("scaffoldProject creates everything in an empty directory", async () => {
  const h = harness();
  const results = await scaffoldProject(h.deps, "/work");

  assertEquals(statusOf(results, "pb_hooks/main.pb.js"), "created");
  assertEquals(statusOf(results, "pb_migrations"), "created");
  assertEquals(statusOf(results, ".gitignore"), "created");

  assertEquals(h.dirs.has("/work/pb_hooks"), true);
  assertEquals(h.dirs.has("/work/pb_migrations"), true);
  assertEquals(
    h.texts.get("/work/pb_hooks/main.pb.js")!.includes("routerAdd"),
    true,
  );
});

Deno.test("scaffoldProject writes a README that explains how to start", async () => {
  const h = harness();
  const results = await scaffoldProject(h.deps, "/work");
  assertEquals(statusOf(results, "README.md"), "created");

  const readme = h.texts.get("/work/README.md")!;
  assertEquals(readme.includes("./pocketbase serve"), true);
  assertEquals(readme.includes("http://127.0.0.1:8090/_/"), true);
  assertEquals(readme.includes('"start": "./pocketbase serve"'), true);
  assertEquals(readme.includes("npm start"), true);
  assertEquals(readme.includes("pb_hooks"), true);
  assertEquals(readme.includes("pb_migrations"), true);
});

Deno.test("scaffoldProject never overwrites an existing README", async () => {
  const h = harness({ "/work/README.md": "# My project" });
  const results = await scaffoldProject(h.deps, "/work");
  assertEquals(statusOf(results, "README.md"), "skipped");
  assertEquals(h.texts.get("/work/README.md"), "# My project");
});

Deno.test("the README starts the server from the binary, not a package runner", async () => {
  const h = harness();
  await scaffoldProject(h.deps, "/work");
  const readme = h.texts.get("/work/README.md")!;
  assertEquals(readme.includes("npx pocketbase"), false);
  assertEquals(readme.includes("npm install pocketbase"), false);
});

Deno.test("scaffoldProject writes every gitignore entry on a fresh file", async () => {
  const h = harness();
  await scaffoldProject(h.deps, "/work");
  const gitignore = h.texts.get("/work/.gitignore")!;
  for (const entry of ["pocketbase", "pocketbase.exe", "pb_data/"]) {
    assertEquals(gitignore.split("\n").includes(entry), true);
  }
  assertEquals(gitignore.endsWith("\n"), true);
});

Deno.test("scaffoldProject never overwrites an existing hook file", async () => {
  const h = harness({ "/work/pb_hooks/main.pb.js": "// mine" });
  const results = await scaffoldProject(h.deps, "/work");
  assertEquals(statusOf(results, "pb_hooks/main.pb.js"), "skipped");
  assertEquals(h.texts.get("/work/pb_hooks/main.pb.js"), "// mine");
});

Deno.test("scaffoldProject appends only the missing gitignore entries", async () => {
  const h = harness({ "/work/.gitignore": "node_modules/\npocketbase\n" });
  const results = await scaffoldProject(h.deps, "/work");
  assertEquals(statusOf(results, ".gitignore"), "updated");
  const lines = h.texts.get("/work/.gitignore")!.split("\n").filter(Boolean);
  assertEquals(lines.filter((l) => l === "pocketbase").length, 1);
  assertEquals(lines.includes("node_modules/"), true);
  assertEquals(lines.includes("pb_data/"), true);
});

Deno.test("scaffoldProject leaves a fully-covered gitignore alone", async () => {
  const h = harness({
    "/work/.gitignore": "pocketbase\npocketbase.exe\npb_data/\n",
  });
  const results = await scaffoldProject(h.deps, "/work");
  assertEquals(statusOf(results, ".gitignore"), "skipped");
  assertEquals(
    h.texts.get("/work/.gitignore"),
    "pocketbase\npocketbase.exe\npb_data/\n",
  );
});

Deno.test("scaffoldProject adds a newline before appending to a file without one", async () => {
  const h = harness({ "/work/.gitignore": "node_modules/" });
  await scaffoldProject(h.deps, "/work");
  const lines = h.texts.get("/work/.gitignore")!.split("\n").filter(Boolean);
  assertEquals(lines[0], "node_modules/");
  assertEquals(lines.includes("pocketbase"), true);
});

Deno.test("scaffoldProject is idempotent", async () => {
  const h = harness();
  await scaffoldProject(h.deps, "/work");
  const before = new Map(h.texts);
  const results = await scaffoldProject(h.deps, "/work");
  assertEquals(results.every((r) => r.status === "skipped"), true);
  for (const [k, v] of before) assertEquals(h.texts.get(k), v);
});
