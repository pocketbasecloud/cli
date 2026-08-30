import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { makeFrontendCommands } from "../../../src/commands/frontend.ts";
import { makeBackendCommands } from "../../../src/commands/backend.ts";
import { makePbCommands } from "../../../src/commands/pb.ts";
import { dispatch } from "../../../src/router.ts";
import {
  createMockCloudClient,
  type MockCloudClient,
} from "../../mocks/cloud.mock.ts";
import {
  createMockDeployFetch,
  type MockDeployFetch,
} from "../../mocks/deployments.mock.ts";
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
  const deploy = createMockDeployFetch();
  const d: CloudCmdDeps & { deploy: MockDeployFetch } = {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    envStatePath: tempStatePath(),
    fetch: deploy.fetchFn,
    deploy,
  };
  return d;
}

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

function uploadedArchive(d: ReturnType<typeof deps>): Uint8Array {
  const put = d.deploy.calls.find((c) => c.url === "https://r2/put");
  return put?.bodyBytes ?? new Uint8Array();
}

const START_TASK = JSON.stringify({ tasks: { start: "deno run -A main.ts" } });

Deno.test("frontend deploy uploads the built bundle to the deploy endpoint", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({
    "vite.config.ts": "export default {}",
    "package.json": "{}",
    "dist/index.html": "<h1>hi</h1>",
    "src/main.ts": "not shipped",
  });
  const d = deps(client, p.id, cwd);
  const cmds = makeFrontendCommands(d);

  const code = await cmds["frontend deploy"].run({ new: "web" }, {
      args: [],
      flags: flags(p.id),
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.zipFile, undefined);
  assertEquals(
    new TextDecoder().decode(
      await extractEntry(uploadedArchive(d), "index.html"),
    ),
    "<h1>hi</h1>",
  );
});

Deno.test("frontend redeploy creates a deployment row, not an uploading record", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const fe = await client.createResource("frontends", {
    name: "web",
    project: p.id,
  });
  runningNow(client);
  const cwd = seed({ "dist/index.html": "x" });
  const d = deps(client, p.id, cwd);
  const cmds = makeFrontendCommands(d);

  await cmds["frontend deploy"].run({ name: "web" }, {
      args: [],
      flags: flags(p.id),
  });

  const [, id, data] = client.calls.updateResource[0];
  assertEquals(id, fe.id);
  assertEquals(data.status, undefined);
  const created = d.deploy.calls.find((c) =>
    c.url.endsWith("/api/deployments") && c.method === "POST"
  );
  assertEquals(created !== undefined, true);
});

Deno.test("frontend deploy rejects --env-file as an unknown flag", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seed({ "dist/index.html": "x" });
  const code = await dispatch(
    makeFrontendCommands(deps(client, p.id, cwd)),
    ["cloud", "frontend", "deploy", "--name", "web", "--env-file", ".env"],
  );
  assertEquals(code, 2);
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("--zip uploads the given archive and skips packaging", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({ "prebuilt.zip": "PK-not-really" });
  const d = deps(client, p.id, cwd);
  const cmds = makeFrontendCommands(d);

  const code = await cmds["frontend deploy"].run({ new: "web", zip: join(cwd, "prebuilt.zip") }, {
      args: [],
      flags: flags(p.id),
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.zipFile, undefined);
  assertEquals(
    new TextDecoder().decode(uploadedArchive(d)),
    "PK-not-really",
  );
});

Deno.test("--zip with a missing path is a usage error", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seed({ "dist/index.html": "x" });
  const cmds = makeFrontendCommands(deps(client, p.id, cwd));

  const err = await assertRejects(
    () =>
      cmds["frontend deploy"].run({ new: "web", zip: join(cwd, "nope.zip") }, {
          args: [],
          flags: flags(p.id),
      }),
    CliError,
    "--zip file not found",
  );
  assertEquals(err.exitCode, 2);
});

Deno.test("a failing build exits 7 and creates no resource", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
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
      cmds["frontend deploy"].run({ new: "web" }, {
          args: [],
          flags: flags(p.id),
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
    "package.json": "{}",
    ".next/standalone/server.js": "listen()",
    ".next/static/chunk.js": "x",
  });
  const d = deps(client, p.id, cwd);
  const cmds = makeBackendCommands(d);

  const code = await cmds["backend deploy"].run({ new: "api" }, {
      args: [],
      flags: flags(p.id),
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.runtime, "nextjs");
  assertEquals(data.startCommand, "node server.js");
  assertEquals(
    new TextDecoder().decode(
      await extractEntry(uploadedArchive(d), "server.js"),
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

  await cmds["backend deploy"].run({ new: "api", start: "node server.js --port 3000" }, {
      args: [],
      flags: flags(p.id),
  });

  const [, data] = client.calls.createResource[0];
  assertEquals(data.startCommand, "node server.js --port 3000");
});

Deno.test("backend deploy pushes nothing when no env file is configured", async () => {
  const cwd = seed({
    "deno.json": START_TASK,
    "main.ts": "x",
    ".env": "A=1\nB=2\n",
  });

  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  await makeBackendCommands(deps(client, p.id, cwd))["backend deploy"].run({ new: "api" }, {
      args: [],
      flags: flags(p.id),
  });
  assertEquals(
    client.calls.ext.some(([path]) => path === "/api/env/bulk-set"),
    false,
  );
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
  await makeBackendCommands(deps(client, p.id, cwd))["backend deploy"].run({ new: "api", envFile: ".env.prod", env: "prod" }, {
      args: [],
      flags: flags(p.id),
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
  await makeBackendCommands(deps(client, p.id, cwd))["backend deploy"].run({ new: "api" }, {
      args: [],
      flags: flags(p.id),
  });
  const push = client.calls.ext.find(([path]) => path === "/api/env/bulk-set");
  assertEquals((push?.[1] as { variables: Record<string, string> }).variables, {
    A: "1",
  });

  const cwd2 = seed(files);
  const client2 = createMockCloudClient();
  const p2 = await client2.createProject("app");
  runningNow(client2);
  await makeBackendCommands(deps(client2, p2.id, cwd2))["backend deploy"].run(
    { new: "api", skipEnv: true },
    { args: [], flags: flags(p2.id) },
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
    "backend deploy"
  ].run(
    { new: "api" },
    { args: [], flags: flags(p.id) },
  );

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
      makeBackendCommands(deps(client, p.id, cwd))["backend deploy"].run({ new: "api", envFile: ".env.production" }, {
          args: [],
          flags: flags(p.id),
      }),
    CliError,
    "Env file not found",
  );
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
      makeBackendCommands(deps(client, p.id, cwd))["backend deploy"].run({ new: "api" }, {
          args: [],
          flags: flags(p.id),
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
  const d = deps(client, p.id, cwd);
  const cmds = makePbCommands(d);

  const code = await cmds["pocketbase deploy"].run({ new: "db" }, {
    args: [],
    flags: flags(p.id),
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.zipFile, undefined);
  const zip = uploadedArchive(d);
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
  const d = deps(client, p.id, cwd);
  const cmds = makePbCommands(d);

  const code = await cmds["pocketbase deploy"].run({ name: "db" }, {
    args: [],
    flags: flags(p.id),
  });

  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 0);
  const [, id, data] = client.calls.updateResource[0];
  assertEquals(id, pb.id);
  assertEquals(data.zipFile, undefined);
  assertEquals(data.status, undefined);
  const dec = new TextDecoder();
  assertEquals(
    dec.decode(await extractEntry(uploadedArchive(d), "pb_migrations/1_init.js")),
    "// migration",
  );
  assertEquals(
    dec.decode(await extractEntry(uploadedArchive(d), "pb_hooks/main.pb.js")),
    "// hook",
  );
  assertEquals(
    client.calls.pbApi.some(([path]) => path === "/api/hooks/bulk-write"),
    false,
  );
});

Deno.test("pb redeploy of a hooks-only directory sends the archive", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  runningNow(client);
  const cwd = seed({ "pb_hooks/main.pb.js": "// hook" });
  const d = deps(client, p.id, cwd);
  const cmds = makePbCommands(d);

  const code = await cmds["pocketbase deploy"].run({ name: "db" }, {
    args: [],
    flags: flags(p.id),
  });

  assertEquals(code, 0);
  const [, , data] = client.calls.updateResource[0];
  assertEquals(data.zipFile, undefined);
  assertEquals(data.status, undefined);
  const dec = new TextDecoder();
  assertEquals(
    dec.decode(await extractEntry(uploadedArchive(d), "pb_hooks/main.pb.js")),
    "// hook",
  );
});

Deno.test("pb deploy of a directory with no pb_* directories creates a deployment row with an empty archive", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({ "README.md": "nothing to deploy" });
  const d = deps(client, p.id, cwd);
  const cmds = makePbCommands(d);

  const code = await cmds["pocketbase deploy"].run({ new: "db" }, {
    args: [],
    flags: flags(p.id),
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.zipFile, undefined);
  assertEquals(data.zipFileSize, undefined);
  assertEquals(
    d.deploy.calls.some((c) => c.url.endsWith("/api/deployments")),
    true,
  );
});

Deno.test("pb redeploy of a configured but empty pb_public still creates a deployment row", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  runningNow(client);
  const cwd = seed({ "README.md": "x" });
  Deno.mkdirSync(join(cwd, "pb_public"));
  const d = deps(client, p.id, cwd);
  const cmds = makePbCommands(d);

  const code = await cmds["pocketbase deploy"].run({ name: "db" }, {
    args: [],
    flags: flags(p.id),
  });

  assertEquals(code, 0);
  const [, , data] = client.calls.updateResource[0];
  assertEquals(data.zipFile, undefined);
  assertEquals(data.status, undefined);
  assertEquals(
    d.deploy.calls.some((c) => c.url.endsWith("/api/deployments")),
    true,
  );
});

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = Deno.stderr.writeSync.bind(Deno.stderr);
  const dec = new TextDecoder();
  Deno.stderr.writeSync = (b: Uint8Array) => {
    chunks.push(dec.decode(b));
    return b.byteLength;
  };
  return {
    text: () => chunks.join(""),
    restore: () => {
      Deno.stderr.writeSync = original;
    },
  };
}

Deno.test("pb deploy says so when there was nothing to deploy", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({ "README.md": "x" });
  const cmds = makePbCommands(deps(client, p.id, cwd));
  const out = captureStderr();

  try {
    const code = await cmds["pocketbase deploy"].run({ new: "db" }, {
      args: [],
      flags: { ...flags(p.id), json: false },
    });
    assertEquals(code, 0);
  } finally {
    out.restore();
  }

  const text = out.text();
  assertEquals(text.includes("nothing to deploy"), true);
  assertEquals(text.includes("pb_public"), true);
  assertEquals(text.includes("pbc.json"), true);
});

async function writeZipFile(
  path: string,
  names: string[],
): Promise<void> {
  const body = new TextEncoder().encode("x");
  await Deno.writeFile(
    path,
    await writeZip(names.map((name) => ({
      name,
      body,
    }))),
  );
}

Deno.test("pb redeploy uploads an explicit --zip", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  runningNow(client);
  const cwd = seed({ "pb_hooks/main.pb.js": "//" });
  await writeZipFile(join(cwd, "old.zip"), ["pb_public/index.html"]);
  const d = deps(client, p.id, cwd);
  const cmds = makePbCommands(d);

  const code = await cmds["pocketbase deploy"].run({
    name: "db",
    zip: join(cwd, "old.zip"),
  }, {
    args: [],
    flags: flags(p.id),
  });

  assertEquals(code, 0);
  const [, , data] = client.calls.updateResource[0];
  assertEquals(data.zipFile, undefined);
  assertEquals(data.status, undefined);
  const dec = new TextDecoder();
  assertEquals(
    dec.decode(await extractEntry(uploadedArchive(d), "pb_public/index.html")),
    "x",
  );
});

Deno.test("pb redeploy refuses a --zip holding neither pb_migrations nor pb_public", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  runningNow(client);
  const cwd = seed({});
  await writeZipFile(join(cwd, "site.zip"), ["index.html", "README.txt"]);
  const cmds = makePbCommands(deps(client, p.id, cwd));

  const err = await assertRejects(
    () =>
      cmds["pocketbase deploy"].run({ name: "db", zip: join(cwd, "site.zip") }, {
        args: [],
        flags: flags(p.id),
      }),
    CliError,
    "pb_migrations",
  );
  assertEquals(err.exitCode, 2);
  assertEquals(err.message.includes("index.html"), true);
  assertEquals(err.message.includes("pb_public"), true);
  assertEquals(client.calls.updateResource.length, 0);
});

Deno.test("pb create accepts a --zip that only seeds pb_hooks", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  runningNow(client);
  const cwd = seed({});
  await writeZipFile(join(cwd, "seed.zip"), ["pb_hooks/main.pb.js"]);
  const d = deps(client, p.id, cwd);
  const cmds = makePbCommands(d);

  const code = await cmds["pocketbase deploy"].run({
    new: "db",
    zip: join(cwd, "seed.zip"),
  }, {
    args: [],
    flags: flags(p.id),
  });

  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.zipFile, undefined);
  const dec = new TextDecoder();
  assertEquals(
    dec.decode(await extractEntry(uploadedArchive(d), "pb_hooks/main.pb.js")),
    "x",
  );
});

Deno.test("a failed deploy reports the platform's own message, not just the sub-status", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  const cwd = seed({ "pb_hooks/main.pb.js": "// hook" });
  const d = deps(client, p.id, cwd);
  d.deploy.setStatus(
    "failed",
    "pb_hooks/lib/helpers.js is inside a subdirectory. Hooks must be flat files.",
  );
  const cmds = makePbCommands(d);

  const err = await assertRejects(
    () =>
      cmds["pocketbase deploy"].run({ name: "db" }, {
        args: [],
        flags: flags(p.id),
      }),
    CliError,
    "inside a subdirectory",
  );
  assertEquals(err.message.includes("pb_hooks/lib/helpers.js"), true);
});
