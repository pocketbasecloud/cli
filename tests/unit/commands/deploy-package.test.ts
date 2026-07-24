import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { makeFrontendCommands } from "../../../src/commands/frontend.ts";
import { makeBackendCommands } from "../../../src/commands/backend.ts";
import { makePbCommands } from "../../../src/commands/pb.ts";
import {
  createMockCloudClient,
  type MockCloudClient,
} from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { CliError } from "../../../src/errors.ts";
import { extractEntry } from "../../../src/local/unzip.ts";

function seed(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

function deps(client: MockCloudClient, projectId: string, cwd: string) {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject: projectId,
  };
  const d: CloudCmdDeps = {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
  };
  return d;
}

/** Make polling terminate immediately. */
function runningNow(client: MockCloudClient) {
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
}

const flags = (projectId: string) => ({
  json: true,
  yes: true,
  noInput: true,
  interactive: false,
  project: projectId,
});

async function zipOf(data: Record<string, unknown>): Promise<Uint8Array> {
  const file = data.zipFile as File;
  return new Uint8Array(await file.arrayBuffer());
}

Deno.test("frontend deploy uploads the built bundle as a file", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  // vite.config → outputDir "dist"; no build script → nothing to run.
  const cwd = seed({
    "vite.config.ts": "export default {}",
    "package.json": "{}",
    "dist/index.html": "<h1>hi</h1>",
    "src/main.ts": "not shipped",
  });
  const cmds = makeFrontendCommands(deps(client, p.id, cwd));

  const code = await cmds["cloud frontend deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "web" },
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  const file = data.zipFile as File;
  assertEquals(file instanceof File, true);
  assertEquals(file.name, "code.zip");
  assertEquals(data.zipFileSize, file.size);
  assertEquals(
    new TextDecoder().decode(
      await extractEntry(await zipOf(data), "index.html"),
    ),
    "<h1>hi</h1>",
  );
});

Deno.test("frontend redeploy marks the record uploading so the service acts on it", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const fe = await client.createResource("frontends", {
    name: "web",
    project: p.id,
  });
  runningNow(client);
  const cwd = seed({ "dist/index.html": "x" });
  const cmds = makeFrontendCommands(deps(client, p.id, cwd));

  await cmds["cloud frontend deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "web" },
  });

  const [, id, data] = client.calls.updateResource[0];
  assertEquals(id, fe.id);
  assertEquals(data.status, "uploading");
  assertEquals((data.zipFile as File) instanceof File, true);
});

Deno.test("frontend deploy rejects --env-file: frontends have no cloud env store", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seed({ "dist/index.html": "x" });
  const cmds = makeFrontendCommands(deps(client, p.id, cwd));

  await assertRejects(
    () =>
      cmds["cloud frontend deploy"]({
        args: [],
        flags: flags(p.id),
        raw: { name: "web", "env-file": ".env" },
      }),
    CliError,
    "no cloud env store",
  );
});

Deno.test("--zip uploads the given archive and skips packaging", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  // No dist/ at all: packaging would fail, so a pass proves it was skipped.
  const cwd = seed({ "prebuilt.zip": "PK-not-really" });
  const cmds = makeFrontendCommands(deps(client, p.id, cwd));

  const code = await cmds["cloud frontend deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "web", zip: join(cwd, "prebuilt.zip") },
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals((data.zipFile as File).name, "prebuilt.zip");
});

Deno.test("--zip with a missing path is a usage error", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seed({ "dist/index.html": "x" });
  const cmds = makeFrontendCommands(deps(client, p.id, cwd));

  const err = await assertRejects(
    () =>
      cmds["cloud frontend deploy"]({
        args: [],
        flags: flags(p.id),
        raw: { name: "web", zip: join(cwd, "nope.zip") },
      }),
    CliError,
    "--zip file not found",
  );
  assertEquals(err.exitCode, 2);
});

Deno.test("a failing build exits 7 and creates no resource", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  // A recorded command, so this exercises the real shell runner without
  // depending on a package manager being installed.
  const cwd = seed({
    "dist/index.html": "x",
    "pb.json": JSON.stringify({
      projectId: "p1",
      build: { command: "exit 3", outputDir: "dist" },
    }),
  });
  const cmds = makeFrontendCommands(deps(client, p.id, cwd));

  const err = await assertRejects(
    () =>
      cmds["cloud frontend deploy"]({
        args: [],
        flags: flags(p.id),
        raw: { name: "web" },
      }),
    CliError,
    "Build failed",
  );
  assertEquals(err.exitCode, 7);
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("backend deploy infers the runtime and assembles a Next.js bundle", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({
    "next.config.mjs": "export default {}",
    "package.json": "{}", // no build script → nothing to run
    ".next/standalone/server.js": "listen()",
    ".next/static/chunk.js": "x",
  });
  const cmds = makeBackendCommands(deps(client, p.id, cwd));

  const code = await cmds["cloud backend deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "api" },
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.runtime, "nextjs");
  assertEquals(data.startCommand, "node server.js");
  assertEquals(
    new TextDecoder().decode(
      await extractEntry(await zipOf(data), "server.js"),
    ),
    "listen()",
  );
});

Deno.test("an explicit --start beats the packager's suggestion", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({
    "next.config.mjs": "",
    "package.json": "{}",
    ".next/standalone/server.js": "x",
  });
  const cmds = makeBackendCommands(deps(client, p.id, cwd));

  await cmds["cloud backend deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "api", start: "node server.js --port 3000" },
  });

  const [, data] = client.calls.createResource[0];
  assertEquals(data.startCommand, "node server.js --port 3000");
});

Deno.test("backend deploy pushes the .env by default and --skip-env opts out", async () => {
  const cwd = seed({ "deno.json": "{}", "main.ts": "x", ".env": "A=1\nB=2\n" });

  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  await makeBackendCommands(deps(client, p.id, cwd))["cloud backend deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "api" },
  });
  const push = client.calls.ext.find(([path]) => path === "/api/env/bulk-set");
  assertEquals((push?.[1] as { vars: Record<string, string> }).vars, {
    A: "1",
    B: "2",
  });
  assertEquals((push?.[1] as { type: string }).type, "backend");

  const client2 = createMockCloudClient();
  const p2 = await client2.createProject("app");
  runningNow(client2);
  await makeBackendCommands(deps(client2, p2.id, cwd))["cloud backend deploy"]({
    args: [],
    flags: flags(p2.id),
    raw: { name: "api", "skip-env": true },
  });
  assertEquals(
    client2.calls.ext.some(([path]) => path === "/api/env/bulk-set"),
    false,
  );
});

Deno.test("no dotenv file means no env push and no error", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({ "deno.json": "{}", "main.ts": "x" });

  const code = await makeBackendCommands(deps(client, p.id, cwd))[
    "cloud backend deploy"
  ]({ args: [], flags: flags(p.id), raw: { name: "api" } });

  assertEquals(code, 0);
  assertEquals(
    client.calls.ext.some(([path]) => path === "/api/env/bulk-set"),
    false,
  );
});

Deno.test("--env-file naming a missing file is an error", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({ "deno.json": "{}", "main.ts": "x" });

  await assertRejects(
    () =>
      makeBackendCommands(deps(client, p.id, cwd))["cloud backend deploy"]({
        args: [],
        flags: flags(p.id),
        raw: { name: "api", "env-file": ".env.production" },
      }),
    CliError,
    "Env file not found",
  );
});

Deno.test("pb deploy packages the three directories on create", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({
    "pb_public/index.html": "<h1>hi</h1>",
    "pb_hooks/main.pb.js": "// hook",
    "pb_migrations/1_init.js": "// migration",
  });
  const cmds = makePbCommands(deps(client, p.id, cwd));

  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "db" },
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals((data.zipFile as File).name, "data.zip");
  const zip = await zipOf(data);
  const dec = new TextDecoder();
  assertEquals(
    dec.decode(await extractEntry(zip, "pb_public/index.html")),
    "<h1>hi</h1>",
  );
  assertEquals(
    dec.decode(await extractEntry(zip, "pb_hooks/main.pb.js")),
    "// hook",
  );
  assertEquals(
    dec.decode(await extractEntry(zip, "pb_migrations/1_init.js")),
    "// migration",
  );
});

Deno.test("pb redeploy pushes hooks instead of an archive the platform ignores", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db",
    project: p.id,
  });
  runningNow(client);
  const cwd = seed({
    "pb_hooks/main.pb.js": "// hook",
    "pb_public/index.html": "x",
  });
  client.calls.createResource.length = 0;
  const cmds = makePbCommands(deps(client, p.id, cwd));

  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "db" },
  });

  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 0);
  // No archive on the update — the platform would never read it.
  const [, id, data] = client.calls.updateResource[0];
  assertEquals(id, pb.id);
  assertEquals(data.zipFile, undefined);
  // Hooks went up the one route that reaches a running instance.
  const push = client.calls.ext.find(([path]) =>
    path === "/api/hooks/bulk-write"
  );
  assertEquals(
    (push?.[1] as { files: { filename: string }[] }).files[0].filename,
    "main.pb.js",
  );
});

Deno.test("pb redeploy refuses --zip rather than uploading it silently", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  runningNow(client);
  const cwd = seed({ "pb_hooks/main.pb.js": "//", "old.zip": "x" });
  const cmds = makePbCommands(deps(client, p.id, cwd));

  await assertRejects(
    () =>
      cmds["cloud pb deploy"]({
        args: [],
        flags: flags(p.id),
        raw: { name: "db", zip: join(cwd, "old.zip") },
      }),
    CliError,
    "only when the instance is created",
  );
});
