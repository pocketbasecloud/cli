import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { makeFrontendCommands } from "../../../src/commands/frontend.ts";
import { makeBackendCommands } from "../../../src/commands/backend.ts";
import { makePbCommands } from "../../../src/commands/pb.ts";
import {
  createMockCloudClient,
  type MockCloudClient,
} from "../../mocks/cloud.mock.ts";
import { tempStatePath } from "../../mocks/state.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { CliError } from "../../../src/errors.ts";
import { extractEntry } from "../../../src/local/unzip.ts";
import { writeZip } from "../../../src/build/zip.ts";

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
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: projectId,
  };
  const d: CloudCmdDeps = {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    envStatePath: tempStatePath(),
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

/** A deno backend must declare how it starts, or deploy refuses to create it. */
const START_TASK = JSON.stringify({ tasks: { start: "deno run -A main.ts" } });

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
    "pbc.json": JSON.stringify({
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

Deno.test("backend deploy pushes nothing when no env file is configured", async () => {
  // A .env sitting in the directory is not an instruction to deploy it, and
  // under --json/--no-input there is nobody to ask.
  const cwd = seed({
    "deno.json": START_TASK,
    "main.ts": "x",
    ".env": "A=1\nB=2\n",
  });

  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  await makeBackendCommands(deps(client, p.id, cwd))["cloud backend deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "api" },
  });
  assertEquals(
    client.calls.ext.some(([path]) => path === "/api/env/bulk-set"),
    false,
  );
  // …and nothing was recorded in pbc.json either.
  const file = JSON.parse(Deno.readTextFileSync(join(cwd, "pbc.json")));
  assertEquals(file.environments.production.build, undefined);
});

Deno.test("backend deploy pushes --env-file and records it for the environment", async () => {
  const cwd = seed({
    "deno.json": START_TASK,
    "main.ts": "x",
    ".env.prod": "A=1\nB=2\n",
  });

  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  await makeBackendCommands(deps(client, p.id, cwd))["cloud backend deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "api", "env-file": ".env.prod", env: "prod" },
  });

  const push = client.calls.ext.find(([path]) => path === "/api/env/bulk-set");
  assertEquals((push?.[1] as { variables: Record<string, string> }).variables, {
    A: "1",
    B: "2",
  });
  assertEquals((push?.[1] as { type: string }).type, "backend");
  const file = JSON.parse(Deno.readTextFileSync(join(cwd, "pbc.json")));
  assertEquals(file.environments.prod.build.envFile, ".env.prod");
});

Deno.test("backend deploy pushes the environment's configured file, and --skip-env opts out", async () => {
  const files = {
    "deno.json": START_TASK,
    "main.ts": "x",
    ".env.prod": "A=1\n",
    "pbc.json": JSON.stringify({
      projectId: "ignored",
      kind: "backends",
      defaultEnvironment: "prod",
      build: { runtime: "deno", startCommand: "deno run -A main.ts" },
      environments: {
        prod: { id: "", name: "api", build: { envFile: ".env.prod" } },
      },
    }),
  };

  const cwd = seed(files);
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  await makeBackendCommands(deps(client, p.id, cwd))["cloud backend deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "api" },
  });
  const push = client.calls.ext.find(([path]) => path === "/api/env/bulk-set");
  assertEquals((push?.[1] as { variables: Record<string, string> }).variables, {
    A: "1",
  });

  const cwd2 = seed(files);
  const client2 = createMockCloudClient();
  const p2 = await client2.createProject("app");
  runningNow(client2);
  await makeBackendCommands(deps(client2, p2.id, cwd2))["cloud backend deploy"](
    {
      args: [],
      flags: flags(p2.id),
      raw: { name: "api", "skip-env": true },
    },
  );
  assertEquals(
    client2.calls.ext.some(([path]) => path === "/api/env/bulk-set"),
    false,
  );
});

Deno.test("no dotenv file means no env push and no error", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({ "deno.json": START_TASK, "main.ts": "x" });

  const code = await makeBackendCommands(deps(client, p.id, cwd))[
    "cloud backend deploy"
  ]({ args: [], flags: flags(p.id), raw: { name: "api" } });

  assertEquals(code, 0);
  assertEquals(
    client.calls.ext.some(([path]) => path === "/api/env/bulk-set"),
    false,
  );
});

Deno.test("a named env file that is missing fails before anything is created", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({ "deno.json": START_TASK, "main.ts": "x" });

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
  // The point of resolving env before the first cloud call: a typo'd path must
  // not leave a provisioned backend behind.
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("a pbc.json-configured env file that is missing fails the same way", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({
    "deno.json": START_TASK,
    "main.ts": "x",
    "pbc.json": JSON.stringify({
      projectId: "ignored",
      kind: "backends",
      defaultEnvironment: "prod",
      environments: {
        prod: { id: "", name: "api", build: { envFile: ".env.prod" } },
      },
    }),
  });

  await assertRejects(
    () =>
      makeBackendCommands(deps(client, p.id, cwd))["cloud backend deploy"]({
        args: [],
        flags: flags(p.id),
        raw: { name: "api" },
      }),
    CliError,
    "Env file not found: .env.prod",
  );
  assertEquals(client.calls.createResource.length, 0);
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

Deno.test("pb redeploy sends hooks inside the archive, not through the hooks route", async () => {
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
    "pb_migrations/1_init.js": "// migration",
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
  // The archive rides on the update, with the status the platform keys the
  // install off.
  const [, id, data] = client.calls.updateResource[0];
  assertEquals(id, pb.id);
  assertEquals((data.zipFile as File).name, "data.zip");
  assertEquals(data.status, "uploading");
  const dec = new TextDecoder();
  assertEquals(
    dec.decode(
      await extractEntry(await zipOf(data), "pb_migrations/1_init.js"),
    ),
    "// migration",
  );
  assertEquals(
    dec.decode(await extractEntry(await zipOf(data), "pb_hooks/main.pb.js")),
    "// hook",
  );
  // The platform installs pb_hooks from the archive through the very route
  // this used to call, so calling it as well would write every file twice and
  // restart the instance twice.
  assertEquals(
    client.calls.pbApi.some(([path]) => path === "/api/hooks/bulk-write"),
    false,
  );
});

Deno.test("pb redeploy of a hooks-only directory sends the archive", async () => {
  // pb_hooks is installed from an archive now, so a directory holding only
  // hooks has something to upload after all.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  runningNow(client);
  const cwd = seed({ "pb_hooks/main.pb.js": "// hook" });
  const cmds = makePbCommands(deps(client, p.id, cwd));

  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "db" },
  });

  assertEquals(code, 0);
  const [, , data] = client.calls.updateResource[0];
  assertEquals((data.zipFile as File).name, "data.zip");
  assertEquals(data.status, "uploading");
});

Deno.test("pb deploy of a directory with no pb_* directories creates without an archive", async () => {
  // A bare instance is a supported deploy, so packaging yields zero files.
  // The archive that describes zero files is 22 bytes of end-of-central-
  // directory and nothing else, which `unzip` refuses outright ("zipfile is
  // empty") — so it must never be attached.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({ "README.md": "nothing to deploy" });
  const cmds = makePbCommands(deps(client, p.id, cwd));

  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "db" },
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.zipFile, undefined);
  assertEquals(data.zipFileSize, undefined);
});

Deno.test("pb redeploy of a configured but empty pb_public sends no archive", async () => {
  // The directory exists, so it is configured — but it holds no files, and an
  // entry-less archive is refused by the agent exactly as an empty one is.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  runningNow(client);
  const cwd = seed({ "README.md": "x" });
  Deno.mkdirSync(join(cwd, "pb_public"));
  const cmds = makePbCommands(deps(client, p.id, cwd));

  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "db" },
  });

  assertEquals(code, 0);
  const [, , data] = client.calls.updateResource[0];
  assertEquals(data.zipFile, undefined);
  assertEquals(data.status, undefined);
});

/**
 * Progress writes straight to stdout rather than through console.log, so the
 * notes a deploy prints are only observable there.
 */
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = Deno.stdout.writeSync.bind(Deno.stdout);
  const dec = new TextDecoder();
  Deno.stdout.writeSync = (b: Uint8Array) => {
    chunks.push(dec.decode(b));
    return b.byteLength;
  };
  return {
    text: () => chunks.join(""),
    restore: () => {
      Deno.stdout.writeSync = original;
    },
  };
}

Deno.test("pb deploy says so when there was nothing to deploy", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({ "README.md": "x" });
  const cmds = makePbCommands(deps(client, p.id, cwd));
  const out = captureStdout();

  try {
    const code = await cmds["cloud pb deploy"]({
      args: [],
      flags: { ...flags(p.id), json: false },
      raw: { name: "db" },
    });
    assertEquals(code, 0);
  } finally {
    out.restore();
  }

  // A deploy that shipped nothing looks identical to one that worked, so the
  // note has to name both the cause and the way out.
  const text = out.text();
  assertEquals(text.includes("nothing to deploy"), true);
  assertEquals(text.includes("pb_public"), true);
  assertEquals(text.includes("pbc.json"), true);
});

/** Writes a real archive to `path`, since --zip is now read before upload. */
async function writeZipFile(
  path: string,
  names: string[],
): Promise<void> {
  const body = new TextEncoder().encode("x");
  await Deno.writeFile(path, await writeZip(names.map((name) => ({
    name,
    body,
  }))));
}

Deno.test("pb redeploy uploads an explicit --zip", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  runningNow(client);
  const cwd = seed({ "pb_hooks/main.pb.js": "//" });
  await writeZipFile(join(cwd, "old.zip"), ["pb_public/index.html"]);
  const cmds = makePbCommands(deps(client, p.id, cwd));

  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "db", zip: join(cwd, "old.zip") },
  });

  assertEquals(code, 0);
  const [, , data] = client.calls.updateResource[0];
  assertEquals((data.zipFile as File).name, "old.zip");
  assertEquals(data.status, "uploading");
});

Deno.test("pb redeploy refuses a --zip holding neither pb_migrations nor pb_public", async () => {
  // The production failure, caught before the upload: the platform would
  // refuse this archive on the VM and mark a healthy instance errored.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  runningNow(client);
  const cwd = seed({});
  await writeZipFile(join(cwd, "site.zip"), ["index.html", "README.txt"]);
  const cmds = makePbCommands(deps(client, p.id, cwd));

  const err = await assertRejects(
    () =>
      cmds["cloud pb deploy"]({
        args: [],
        flags: flags(p.id),
        raw: { name: "db", zip: join(cwd, "site.zip") },
      }),
    CliError,
    "pb_migrations",
  );
  assertEquals(err.exitCode, 2);
  // Naming what it did find is what turns this from a rule into a diagnosis.
  assertEquals(err.message.includes("index.html"), true);
  assertEquals(err.message.includes("pb_public"), true);
  // Nothing was sent, so the instance is untouched.
  assertEquals(client.calls.updateResource.length, 0);
});

Deno.test("pb create accepts a --zip that only seeds pb_hooks", async () => {
  // Creation extracts the archive wholesale — pb_hooks is a legitimate seed
  // there, and only the *upload* route is restricted to the two directories.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({});
  await writeZipFile(join(cwd, "seed.zip"), ["pb_hooks/main.pb.js"]);
  const cmds = makePbCommands(deps(client, p.id, cwd));

  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags(p.id),
    raw: { name: "db", zip: join(cwd, "seed.zip") },
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals((data.zipFile as File).name, "seed.zip");
});

Deno.test("a failed deploy reports the platform's own message, not just the sub-status", async () => {
  // `subStatus` maps to one fixed sentence per runtime, so it can say a hook
  // could not be installed but never which one. `statusMessage` is the only
  // field that can name the file, so it wins whenever the platform wrote one.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "error",
    subStatus: "hooksNotInstallable",
    statusMessage:
      "pb_hooks/lib/helpers.js is inside a subdirectory. Hooks must be flat files.",
  });
  const cwd = seed({ "pb_hooks/main.pb.js": "// hook" });
  const cmds = makePbCommands(deps(client, p.id, cwd));
  const out = captureStdout();

  try {
    await cmds["cloud pb deploy"]({
      args: [],
      flags: { ...flags(p.id), json: false },
      raw: { name: "db" },
    });
  } finally {
    out.restore();
  }

  const text = out.text();
  assertEquals(text.includes("pb_hooks/lib/helpers.js"), true);
  assertEquals(text.includes("inside a subdirectory"), true);
});
