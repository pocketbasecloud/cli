import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  authorLabel,
  boundRevision,
  buildOverSourceWarning,
  describeRestore,
  describeSourceRestore,
  editedAsSource,
  isPullablePath,
  liveBuildLine,
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

async function setup(
  routes: Record<string, (body: unknown) => unknown>,
  o: {
    files?: [string, string][];
    deployment?: string;
    deploymentMessage?: string;
  } = {},
) {
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
  const web = await client.createResource("frontends", {
    name: "web",
    project: p.id,
  });
  const zip = await writeZip(
    (o.files ?? [
      ["pb_hooks/main.pb.js", "hook v1"],
      ["pb_public/index.html", "<h1>"],
    ]).map(([name, body]) => ({ name, body: text(body) })),
  );
  const deps: CloudCmdDeps = {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    fetch: (input) =>
      Promise.resolve(
        String(input).includes("/deployments/records/")
          ? Response.json({
            status: o.deployment ?? "success",
            statusMessage: o.deploymentMessage ?? "",
          })
          : new Response(zip as BodyInit),
      ),
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
  return { run, posted, cwd, db, web, lastData };
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

Deno.test("website revisions use the owner route of their kind", async () => {
  const { run, posted, web, lastData } = await setup({
    list: () => ({
      page: 1,
      totalPages: 1,
      items: [{ number: 2, status: "building", source: "cli", created: "c" }],
    }),
  });
  assertEquals(await run("website revisions ls", [], { name: "web" }), 0);
  assertEquals(posted[0], [
    "/api/revisions/list",
    { kind: "frontends", resourceId: web.id, page: 1, perPage: 30 },
  ]);
  assertEquals(lastData()[0].status, "building");
});

Deno.test("website revisions show takes any relative source path", async () => {
  const { run, posted } = await setup({
    file: () => ({ path: "src/App.tsx", size: 2, content: "hi" }),
  });
  await run("website revisions show", ["3", "src/App.tsx"], { name: "web" });
  assertEquals(posted[0][0], "/api/revisions/file");
  await assertRejects(
    () => run("website revisions show", ["3", "../x"], { name: "web" }),
    CliError,
    "relative path",
  );
});

Deno.test("website revisions restore waits for the build and reports it", async () => {
  const { run, posted, lastData } = await setup({
    "restore-preview": () => ({
      number: 1,
      current: 4,
      filesWritten: ["src/App.tsx"],
      filesRemoved: [],
    }),
    restore: () => ({ revision: 5, deploymentId: "dep1" }),
  });
  await run("website revisions restore", ["1"], { name: "web" }, {
    yes: true,
  });
  assertEquals(lastData(), {
    restored: true,
    revision: 5,
    deploymentId: "dep1",
  });
  const restore = posted.find(([path]) => path === "/api/revisions/restore")!;
  assertEquals(restore[1], {
    kind: "frontends",
    resourceId: (restore[1] as { resourceId: string }).resourceId,
    number: 1,
    mode: "files",
    baseRevision: 4,
  });
});

Deno.test("website revisions restore fails with the build's own message", async () => {
  const { run } = await setup({
    "restore-preview": () => ({
      number: 1,
      current: 4,
      filesWritten: ["src/App.tsx"],
      filesRemoved: [],
    }),
    restore: () => ({ revision: 5, deploymentId: "dep1" }),
  }, {
    deployment: "failed",
    deploymentMessage: "Build failed: vite exited 1",
  });
  await assertRejects(
    () =>
      run("website revisions restore", ["1"], { name: "web" }, { yes: true }),
    CliError,
    "vite exited 1",
  );
});

Deno.test("website revisions restore stops when the source already matches", async () => {
  const { run, posted, lastData } = await setup({
    "restore-preview": () => ({
      number: 1,
      current: 4,
      filesWritten: [],
      filesRemoved: [],
    }),
  });
  assertEquals(
    await run("website revisions restore", ["1"], { name: "web" }),
    0,
  );
  assertEquals(lastData(), { restored: false, revision: null });
  assertEquals(
    posted.some(([path]) => path === "/api/revisions/restore"),
    false,
  );
});

Deno.test("a source restore plan names the files and counts the rest", () => {
  const preview = {
    number: 1,
    filesWritten: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"],
    filesRemoved: ["old.ts"],
  };
  assertEquals(describeSourceRestore(preview), [
    "  write   a.ts, b.ts, c.ts, d.ts, e.ts, and 2 more",
    "  remove  old.ts",
  ]);
  assertEquals(describeSourceRestore({ number: 1 }), []);
});

Deno.test("only a PocketBase restore has --schema", () => {
  const cmds = makeRevisionCommands({} as CloudCmdDeps);
  assertEquals("schema" in cmds["pocketbase revisions restore"].flags, true);
  assertEquals("schema" in cmds["service revisions restore"].flags, false);
});

Deno.test("website pull writes the source and remembers its revision", async () => {
  const { run, cwd, web } = await setup({
    export: () => ({ number: 6, files: 2, downloadUrl: "https://r2/x.zip" }),
  }, { files: [["src/main.ts", "v1"], ["package.json", "{}"]] });
  await Deno.writeTextFile(
    join(cwd, "pbc.json"),
    JSON.stringify({
      projectId: web.project,
      kind: "frontends",
      defaultEnvironment: "production",
      environments: { production: { id: web.id, name: "web" } },
    }),
  );
  await run("website pull", [], { name: undefined });
  assertEquals(await Deno.readTextFile(join(cwd, "src", "main.ts")), "v1");
  assertEquals(await boundRevision(cwd, "production", web.id), 6);
});

Deno.test("website pull keeps the directory's own pbc.json", async () => {
  const { run, cwd, web, lastData } = await setup({
    export: () => ({ number: 6, files: 2, downloadUrl: "https://r2/x.zip" }),
  }, {
    files: [["src/main.ts", "v1"], ["pbc.json", JSON.stringify({ kind: "x" })]],
  });
  const binding = {
    projectId: web.project,
    kind: "frontends",
    defaultEnvironment: "production",
    environments: { production: { id: web.id, name: "web" } },
  };
  await Deno.writeTextFile(join(cwd, "pbc.json"), JSON.stringify(binding));
  assertEquals(await run("website pull", [], { name: undefined }), 0);
  assertEquals(await Deno.readTextFile(join(cwd, "src", "main.ts")), "v1");
  assertEquals(await boundRevision(cwd, "production", web.id), 6);
  assertEquals(lastData().overwritten, 0);
  assertEquals(lastData().files, 1);
});

Deno.test("website pull writes pbc.json where there is none", async () => {
  const { run, cwd } = await setup({
    export: () => ({ number: 6, files: 2, downloadUrl: "https://r2/x.zip" }),
  }, {
    files: [["src/main.ts", "v1"], ["pbc.json", JSON.stringify({ kind: "x" })]],
  });
  await run("website pull", [], { name: "web" });
  assertEquals(await Deno.readTextFile(join(cwd, "pbc.json")), '{"kind":"x"}');
});

Deno.test("source paths can be pulled anywhere inside the directory", () => {
  assertEquals(isPullablePath("src/a/b.ts", "frontends"), true);
  assertEquals(isPullablePath("package.json", "backends"), true);
  for (const bad of ["../x", "/etc/passwd", "a//b", "a\\b", "./a", "a/./b"]) {
    assertEquals(isPullablePath(bad, "frontends"), false, bad);
  }
});

Deno.test("the live build line names how it was uploaded and that a save replaces it", () => {
  assertEquals(
    liveBuildLine({
      deploymentId: "d9",
      created: "2026-11-02 09:00:00.000Z",
      via: "cli",
    }),
    "Live runs a build uploaded with the CLI on 2026-11-02, not this source. The next save in PocketBase Cloud builds this source and replaces it.",
  );
  assertEquals(
    liveBuildLine({
      deploymentId: "d9",
      created: "2026-11-02 09:00:00.000Z",
      via: "upload",
    }).startsWith("Live runs a finished build uploaded on 2026-11-02,"),
    true,
  );
});

Deno.test("a build over source warns and names the way to keep them in sync", () => {
  assertEquals(
    buildOverSourceWarning("web", "frontends"),
    "web is edited as source in PocketBase Cloud. This build replaces it until the next save there; use --source to keep them in sync.",
  );
  assertEquals(
    buildOverSourceWarning("shop", "backends").endsWith(
      "deploy its source from the portal or GitHub to keep them in sync.",
    ),
    true,
  );
});

Deno.test("only a resource the platform answers as source-managed is edited as source", async () => {
  const answers: Record<string, Response> = {
    managed: Response.json({ success: true, data: { sourceManaged: true } }),
    fresh: Response.json({
      success: true,
      data: { sourceManaged: true, current: 0 },
    }),
    built: Response.json(
      { success: false, code: "notSourceManaged" },
      { status: 409 },
    ),
  };
  const posted: unknown[] = [];
  const client = createMockCloudClient({
    ext: (path, body) => {
      posted.push([path, body]);
      const id = (body as { resourceId: string }).resourceId;
      return id === "down"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(answers[id]);
    },
  });
  assertEquals(await editedAsSource(client, "frontends", "managed"), true);
  assertEquals(await editedAsSource(client, "frontends", "built"), false);
  assertEquals(await editedAsSource(client, "frontends", "fresh"), false);
  assertEquals(await editedAsSource(client, "backends", "down"), false);
  assertEquals(posted[0], [
    "/api/revisions/list",
    { kind: "frontends", resourceId: "managed", page: 1, perPage: 1 },
  ]);
});
