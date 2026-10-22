import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { CliError } from "../../../src/errors.ts";
import { makePbCommands } from "../../../src/commands/pb.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import { join } from "@std/path";

Deno.test("hooks push reads dir and calls bulk-write", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "main.pb.js"), "routerAdd()");
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makePbCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
  });
  const code = await cmds["pocketbase hooks push"].run(
    { name: "db1" },
    {
      args: [dir],
      flags: {
        json: true,
        yes: true,
        noInput: true,
        interactive: false,
        project: p.id,
      },
    },
  );
  assertEquals(code, 0);
  const [path, body] = client.calls.pbApi[0];
  assertEquals(path, "/api/hooks/bulk-write");
  assertEquals((body as { pocketbase_id: string }).pocketbase_id, pb.id);
  const hook = (body as { hooks: { filename: string; active: boolean }[] })
    .hooks[0];
  assertEquals(hook.filename, "main.pb.js");
  assertEquals(hook.active, true);
});

Deno.test("hooks push sends the bound revision and remembers the new one", async () => {
  const root = await Deno.makeTempDir();
  const dir = join(root, "pb_hooks");
  await Deno.mkdir(dir);
  await Deno.writeTextFile(join(dir, "main.pb.js"), "routerAdd()");
  const client = createMockCloudClient({
    ext: (path) =>
      Promise.resolve(
        path === "/api/pocketbases/revisions/list"
          ? Response.json({ success: true, data: { items: [{ number: 9 }] } })
          : Response.json({ success: true }),
      ),
  });
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  await Deno.writeTextFile(
    join(root, "pbc.json"),
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1", revision: 7 } },
    }),
  );
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makePbCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => root,
  });
  await cmds["pocketbase hooks push"].run({}, {
    args: [dir],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
  });
  const [, body] = client.calls.pbApi[0];
  assertEquals((body as { base_revision?: number }).base_revision, 7);
  assertEquals(
    (body as { hooks: { filename: string }[] }).hooks.map((h) => h.filename),
    ["main.pb.js"],
  );
  const link = JSON.parse(await Deno.readTextFile(join(root, "pbc.json")));
  assertEquals(link.environments.production.revision, 9);
});

Deno.test("a hook push the instance cannot start with remembers the undo's revision and fails", async () => {
  const root = await Deno.makeTempDir();
  const dir = join(root, "pb_hooks");
  await Deno.mkdir(dir);
  await Deno.writeTextFile(join(dir, "main.pb.js"), "rooterAdd()");
  const client = createMockCloudClient({
    pbApi: () =>
      Promise.resolve(
        Response.json({
          error: "Failed to write hooks",
          details:
            "Revision #8 did not start: pb_hooks/main.pb.js:1:1. The previous hooks and public files were put back as revision #9.",
          code: "startupFailed",
          revision: 9,
        }, { status: 422 }),
      ),
  });
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  await Deno.writeTextFile(
    join(root, "pbc.json"),
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1", revision: 7 } },
    }),
  );
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makePbCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => root,
  });

  const error = await assertRejects(
    () =>
      cmds["pocketbase hooks push"].run({}, {
        args: [dir],
        flags: {
          json: true,
          yes: true,
          noInput: true,
          interactive: false,
          project: p.id,
        },
      }),
    CliError,
  );
  assertStringIncludes(error.message, "pb_hooks/main.pb.js:1:1");
  const link = JSON.parse(await Deno.readTextFile(join(root, "pbc.json")));
  assertEquals(link.environments.production.revision, 9);
});

Deno.test("hooks push labels the revision with the local commit", async () => {
  const root = await Deno.makeTempDir();
  const git = (...args: string[]) =>
    new Deno.Command("git", {
      args: ["-c", "user.name=Octo Cat", "-c", "user.email=o@c.dev", ...args],
      cwd: root,
      stdout: "null",
      stderr: "null",
    }).output();
  await git("init", "-q");
  const dir = join(root, "pb_hooks");
  await Deno.mkdir(dir);
  await Deno.writeTextFile(join(dir, "main.pb.js"), "routerAdd()");
  await git("add", ".");
  await git("commit", "-q", "-m", "Add auth hook");
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db1", project: p.id });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makePbCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => root,
  });
  await cmds["pocketbase hooks push"].run({ name: "db1" }, {
    args: [dir],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
  });
  const [, body] = client.calls.pbApi[0];
  const sent =
    (body as { git?: { sha: string; title: string; author: string } })
      .git;
  assertEquals(sent?.title, "Add auth hook");
  assertEquals(sent?.author, "Octo Cat");
  assertEquals(sent?.sha.length, 40);
});
