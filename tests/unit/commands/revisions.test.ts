import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  authorLabel,
  boundRevision,
  describeRestore,
  isPullablePath,
  makeRevisionCommands,
  rememberRevision,
} from "../../../src/commands/revisions.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { writeZip } from "../../../src/build/zip.ts";
import { CliError } from "../../../src/errors.ts";

const text = (s: string) => new TextEncoder().encode(s);

const PREVIEW = {
  number: 3,
  current: 6,
  hooksWritten: ["pb_hooks/a.pb.js"],
  hooksRemoved: [],
  publicReplaced: false,
  migrationsReverted: [],
  schemaBlocker: null,
};

async function setup(routes: Record<string, (body: unknown) => unknown>) {
  const posted: [string, unknown][] = [];
  const client = createMockCloudClient({
    ext: (path, body) => {
      if (path.startsWith("/api/github/")) {
        return Promise.resolve(Response.json({}, { status: 503 }));
      }
      posted.push([path, body]);
      const action = path.split("/").pop()!;
      const route = routes[action];
      return Promise.resolve(
        route
          ? Response.json({ success: true, data: route(body) })
          : Response.json({ success: false, message: "no route" }, {
            status: 500,
          }),
      );
    },
  });
  const p = await client.createProject("app");
  const db = await client.createResource("pocketbases", {
    name: "db",
    project: p.id,
  });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cwd = await Deno.makeTempDir();
  const zip = await writeZip([
    { name: "pb_hooks/main.pb.js", body: text("hook v1") },
    { name: "pb_public/index.html", body: text("<h1>") },
  ]);
  const deps: CloudCmdDeps = {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    fetch: () => Promise.resolve(new Response(zip as BodyInit)),
  };
  const cmds = makeRevisionCommands(deps);
  const lines: string[] = [];
  const run = async (
    key: string,
    args: string[],
    input: Record<string, unknown> = {},
    flags: Record<string, unknown> = {},
  ) => {
    const original = console.log;
    const originalError = console.error;
    console.log = (m: string) => lines.push(m);
    console.error = () => {};
    try {
      return await cmds[key].run({ name: "db", ...input }, {
        args,
        flags: {
          json: true,
          yes: false,
          noInput: true,
          interactive: false,
          project: p.id,
          ...flags,
        },
      });
    } finally {
      console.log = original;
      console.error = originalError;
    }
  };
  const lastData = () => JSON.parse(lines[lines.length - 1]).data;
  return { run, posted, cwd, db, lastData };
}

Deno.test("revisions ls labels the source and the author", async () => {
  const { run, lastData, db, posted } = await setup({
    list: () => ({
      page: 1,
      totalPages: 1,
      items: [
        {
          number: 2,
          source: "mcp",
          author: "u1",
          message: "m2",
          created: "c2",
        },
        {
          number: 1,
          source: "instance",
          author: "",
          message: "m1",
          created: "c1",
        },
      ],
    }),
  });
  assertEquals(await run("pocketbase revisions ls", []), 0);
  assertEquals(posted[0], [
    "/api/pocketbases/revisions/list",
    { pocketbaseId: db.id, page: 1, perPage: 30 },
  ]);
  assertEquals(lastData().map((r: { number: number }) => r.number), [2, 1]);
});

Deno.test("revisions restore needs confirmation, then reports how to undo", async () => {
  const { run, posted, lastData } = await setup({
    "restore-preview": () => PREVIEW,
    restore: () => ({ revision: 7 }),
  });
  await assertRejects(
    () => run("pocketbase revisions restore", ["3"]),
    CliError,
    "--yes",
  );
  assertEquals(posted.map(([path]) => path), [
    "/api/pocketbases/revisions/restore-preview",
  ]);

  await run("pocketbase revisions restore", ["3"], {}, { yes: true });
  assertEquals(lastData(), { restored: true, revision: 7 });
  const restore = posted.find(([path]) => path.endsWith("/restore"))![1];
  assertEquals((restore as { baseRevision?: number }).baseRevision, 6);
});

Deno.test("revisions restore refuses a revision that is not a number", async () => {
  const { run } = await setup({});
  await assertRejects(
    () => run("pocketbase revisions restore", ["latest"], {}, { yes: true }),
    CliError,
  );
});

Deno.test("pull writes the files and keeps local-only files", async () => {
  const { run, cwd, lastData } = await setup({
    export: () => ({ number: 4, files: 2, downloadUrl: "https://r2/x.zip" }),
  });
  await Deno.writeTextFile(join(cwd, "notes.md"), "mine");

  assertEquals(await run("pocketbase pull", []), 0);

  assertEquals(
    await Deno.readTextFile(join(cwd, "pb_hooks", "main.pb.js")),
    "hook v1",
  );
  assertEquals(
    await Deno.readTextFile(join(cwd, "pb_public", "index.html")),
    "<h1>",
  );
  assertEquals(await Deno.readTextFile(join(cwd, "notes.md")), "mine");
  assertEquals(lastData().revision, 4);
  assertEquals(lastData().overwritten, 0);
});

Deno.test("pull asks before overwriting a local file that differs", async () => {
  const { run, cwd } = await setup({
    export: () => ({ number: 4, files: 2, downloadUrl: "https://r2/x.zip" }),
  });
  await Deno.mkdir(join(cwd, "pb_hooks"));
  await Deno.writeTextFile(join(cwd, "pb_hooks", "main.pb.js"), "local edit");

  await assertRejects(() => run("pocketbase pull", []), CliError, "--yes");
  assertEquals(
    await Deno.readTextFile(join(cwd, "pb_hooks", "main.pb.js")),
    "local edit",
  );

  await run("pocketbase pull", [], {}, { yes: true });
  assertEquals(
    await Deno.readTextFile(join(cwd, "pb_hooks", "main.pb.js")),
    "hook v1",
  );
});

Deno.test("only paths inside the three directories can be pulled", () => {
  assertEquals(isPullablePath("pb_hooks/lib/a.js"), true);
  for (
    const bad of [
      "pb_data/data.db",
      "pb_hooks/../x",
      "pb_hooks",
      "/etc/passwd",
      "pb_public\\a",
      "pb_public//a",
    ]
  ) {
    assertEquals(isPullablePath(bad), false, bad);
  }
});

Deno.test("authors read as you, teammate or platform", () => {
  assertEquals(authorLabel("u1", "u1"), "you");
  assertEquals(authorLabel("u2", "u1"), "teammate");
  assertEquals(authorLabel("", "u1"), "platform");
});

Deno.test("revisions restore --schema asks for the schema mode", async () => {
  const { run, posted } = await setup({
    "restore-preview": () => ({ ...PREVIEW, migrationsReverted: ["2_b.js"] }),
    restore: () => ({ revision: 8 }),
  });
  await run("pocketbase revisions restore", ["3"], { schema: true }, {
    yes: true,
  });
  assertEquals(
    posted.map(([, body]) => (body as { mode: string }).mode),
    ["filesAndSchema", "filesAndSchema"],
  );
});

Deno.test("revisions restore stops at the platform's schema blocker", async () => {
  const { run, posted } = await setup({
    "restore-preview": () => ({
      ...PREVIEW,
      migrationsReverted: ["2_b.js"],
      schemaBlocker: "Reverting the schema needs PocketBase 0.32.0 or later",
    }),
  });
  const error = await assertRejects(
    () =>
      run("pocketbase revisions restore", ["3"], { schema: true }, {
        yes: true,
      }),
    CliError,
    "0.32.0",
  );
  assertEquals(error.code, "CONFLICT");
  assertEquals(posted.length, 1);
});

Deno.test("revisions restore does nothing when the files already match", async () => {
  const { run, posted, lastData } = await setup({
    "restore-preview": () => ({ ...PREVIEW, hooksWritten: [] }),
  });
  await run("pocketbase revisions restore", ["3"], {}, { yes: true });
  assertEquals(posted.length, 1);
  assertEquals(lastData(), { restored: false, revision: null });
});

Deno.test("describeRestore lists every kind of change", () => {
  assertEquals(
    describeRestore({
      ...PREVIEW,
      hooksRemoved: ["pb_hooks/b.pb.js"],
      publicReplaced: true,
      migrationsReverted: ["3_c.js", "2_b.js"],
    }),
    [
      "  write   pb_hooks/a.pb.js",
      "  remove  pb_hooks/b.pb.js",
      "  replace pb_public",
      "  revert  3_c.js, 2_b.js (down parts, newest first)",
    ],
  );
});

Deno.test("pull into a bound directory remembers the revision for later writes", async () => {
  const { run, cwd, db } = await setup({
    export: () => ({ number: 4, files: 2, downloadUrl: "https://r2/x.zip" }),
  });
  await Deno.writeTextFile(
    join(cwd, "pbc.json"),
    JSON.stringify({
      projectId: db.project,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: db.id, name: "db" } },
    }),
  );

  await run("pocketbase pull", [], { name: undefined });

  assertEquals(await boundRevision(cwd, "production", db.id), 4);
  assertEquals(
    await boundRevision(cwd, "production", "someone-else"),
    undefined,
  );
});

Deno.test("rememberRevision never creates a binding that does not exist", async () => {
  const cwd = await Deno.makeTempDir();
  await rememberRevision(cwd, "production", { id: "pb1", name: "db" }, 3);
  assertEquals(
    await Deno.stat(join(cwd, "pbc.json")).then(() => true, () => false),
    false,
  );
});
