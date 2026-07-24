import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { makeCloudInitCommands } from "../../../src/commands/init.ts";
import { readOwnPbJson } from "../../../src/config.ts";
import { CliError } from "../../../src/errors.ts";

function seed(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

const flags = { json: true, yes: true, noInput: true, interactive: false };

function run(cwd: string, args: string[], raw: Record<string, unknown> = {}) {
  return makeCloudInitCommands({ cwd: () => cwd })["cloud init"]({
    args,
    flags,
    raw,
  });
}

Deno.test("cloud init writes the inferred block for an explicit kind", async () => {
  const cwd = seed({ "deno.json": "{}", "main.ts": "x" });
  assertEquals(await run(cwd, ["backend"]), 0);
  assertEquals((await readOwnPbJson(cwd)).build?.runtime, "deno");
});

Deno.test("cloud init accepts the pb and pocketbase aliases", async () => {
  const cwd = seed({ "pb_hooks/main.pb.js": "//" });
  assertEquals(await run(cwd, ["pb"]), 0);
  assertEquals((await readOwnPbJson(cwd)).build?.pbHooks, "pb_hooks");
});

Deno.test("cloud init takes the kind from the directory's binding", async () => {
  const cwd = seed({
    "vite.config.ts": "",
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "frontends",
      environments: { production: { id: "f1", name: "web" } },
    }),
  });
  assertEquals(await run(cwd, []), 0);
  const own = await readOwnPbJson(cwd);
  assertEquals(own.build?.outputDir, "dist");
  // The binding survives the write.
  assertEquals(own.environments?.production.id, "f1");
});

Deno.test("cloud init errors when there is no kind to infer for", async () => {
  await assertRejects(
    () => run(seed({ "deno.json": "{}" }), []),
    CliError,
    "not bound to a resource",
  );
});

Deno.test("cloud init rejects an unknown kind", async () => {
  await assertRejects(
    () => run(seed({}), ["database"]),
    CliError,
    'Unknown kind "database"',
  );
});

Deno.test("cloud init leaves an existing block alone unless forced", async () => {
  const cwd = seed({
    "vite.config.ts": "",
    "pb.json": JSON.stringify({
      projectId: "p1",
      build: { outputDir: "public" },
    }),
  });

  assertEquals(await run(cwd, ["frontend"]), 0);
  assertEquals((await readOwnPbJson(cwd)).build?.outputDir, "public");

  assertEquals(await run(cwd, ["frontend"], { force: true }), 0);
  assertEquals((await readOwnPbJson(cwd)).build?.outputDir, "dist");
});
