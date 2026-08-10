import { assertEquals, assertRejects } from "@std/assert";
import { makeBackendCommands } from "../../../src/commands/backend.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { tempStatePath } from "../../mocks/state.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";

/** A directory with something to package, so deploy has a zip to upload. */
function seedSource(): string {
  const cwd = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${cwd}/main.ts`, "console.log(1);\n");
  return cwd;
}

Deno.test("backend deploy sends runtime and start command", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seedSource();
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeBackendCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    envStatePath: tempStatePath(),
  });
  const code = await cmds["cloud backend deploy"]({
    args: [],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
    raw: { name: "api", runtime: "deno", start: "deno task start" },
  });
  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.runtime, "deno");
  assertEquals(data.startCommand, "deno task start");
  // `user` is required by the collection and is what the slot check reads.
  assertEquals(data.user, "u1");
  assertEquals(data.status, "pending");
});

Deno.test("backend rm keeps a binding it did not resolve", async () => {
  // `rm --name other` resolved a resource the environment does not track, so
  // the environment must survive.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const bound = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  const other = await client.createResource("backends", {
    name: "api-old",
    project: p.id,
  });
  const cwd = seedSource();
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const d = {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    envStatePath: tempStatePath(),
  };
  await Deno.writeTextFile(
    `${cwd}/pb.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "backends",
      defaultEnvironment: "production",
      environments: { production: { id: bound.id, name: "api" } },
    }),
  );
  const code = await makeBackendCommands(d)["cloud backend rm"]({
    args: [],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
    raw: { name: "api-old" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.updateResource[0][1], other.id);
  const file = JSON.parse(await Deno.readTextFile(`${cwd}/pb.json`));
  assertEquals(file.environments, {
    production: { id: bound.id, name: "api" },
  });
});

Deno.test("backend deploy forwards --compute, which Pro deploys cannot do without", async () => {
  // A Pro account's dedicated compute is `ownership: "user"`, and the
  // platform's auto-selection only ever considers platform servers.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seedSource();
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  await makeBackendCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    envStatePath: tempStatePath(),
  })["cloud backend deploy"]({
    args: [],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
    // --start is incidental here; a source backend cannot be created without
    // one, and this test is about --compute.
    raw: {
      name: "api",
      runtime: "deno",
      compute: "srv1",
      start: "deno task start",
    },
  });
  assertEquals(client.calls.createResource[0][1].server, "srv1");
});

/** Deps in the shape every test here builds by hand. */
function backendDeps(
  client: ReturnType<typeof createMockCloudClient>,
  cwd: string,
  projectId: string,
) {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: projectId,
  };
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    envStatePath: tempStatePath(),
  };
}

const deployFlags = (projectId: string) => ({
  json: true,
  yes: true,
  noInput: true,
  interactive: false,
  project: projectId,
});

Deno.test("backend deploy uses the inferred start command with no --start", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seedSource();
  Deno.writeTextFileSync(
    `${cwd}/deno.json`,
    JSON.stringify({ tasks: { start: "deno run -A main.ts" } }),
  );
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
  const cmds = makeBackendCommands(backendDeps(client, cwd, p.id));
  const code = await cmds["cloud backend deploy"]({
    args: [],
    flags: deployFlags(p.id),
    raw: { name: "api" },
  });
  assertEquals(code, 0);
  assertEquals(
    client.calls.createResource[0][1].startCommand,
    "deno task start",
  );
});

/** A mock whose deploy-context reports the project owner's compute. */
function withComputes(
  client: ReturnType<typeof createMockCloudClient>,
  computes: { id: string; name: string; location: string }[],
  context: { ownerPlan?: string; isOwner?: boolean; organization?: string } =
    {},
) {
  client.deployContext = () =>
    Promise.resolve({
      ownerPlan: context.ownerPlan ?? "pro",
      isOwner: context.isOwner ?? true,
      organization: context.organization ?? "",
      servers: computes,
    });
  return client;
}

/** Reports every resource as running, so deploy's status poll terminates. */
function reportRunning(client: ReturnType<typeof createMockCloudClient>) {
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
  return client;
}

Deno.test("backend deploy creates on the owner's compute with no --compute", async () => {
  const client = reportRunning(createMockCloudClient());
  const p = await client.createProject("app");
  withComputes(client, [{ id: "srv9", name: "pro-1", location: "GRA" }]);
  const cwd = seedSource();
  const cmds = makeBackendCommands(backendDeps(client, cwd, p.id));
  const code = await cmds["cloud backend deploy"]({
    args: [],
    flags: deployFlags(p.id),
    raw: { name: "api", runtime: "deno", start: "deno task start" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "srv9");
});

Deno.test("backend deploy works for an org developer on the owner's Pro compute", async () => {
  // The developer's own plan is irrelevant — a free account deploying into a
  // project shared by a Pro organization is billed to, and runs on, the owner.
  const client = reportRunning(createMockCloudClient());
  client.whoami = () =>
    Promise.resolve({ id: "dev1", email: "dev@e.com", plan: "free" });
  const p = await client.createProject("app");
  withComputes(client, [{ id: "owner-srv", name: "pro-1", location: "GRA" }], {
    isOwner: false,
  });
  const cwd = seedSource();
  const cmds = makeBackendCommands(backendDeps(client, cwd, p.id));
  const code = await cmds["cloud backend deploy"]({
    args: [],
    flags: deployFlags(p.id),
    raw: { name: "api", runtime: "deno", start: "deno task start" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "owner-srv");
});

Deno.test("backend redeploy never re-picks the compute", async () => {
  // Moving a running backend to another host on a routine redeploy would
  // change its URL and drop its data — so the context is not even consulted.
  const client = reportRunning(createMockCloudClient());
  const p = await client.createProject("app");
  await client.createResource("backends", { name: "api", project: p.id });
  client.calls.createResource.length = 0; // seeding is not the deploy's doing
  client.deployContext = () => {
    throw new Error("deploy-context must not be called on a redeploy");
  };
  const cwd = seedSource();
  const cmds = makeBackendCommands(backendDeps(client, cwd, p.id));
  const code = await cmds["cloud backend deploy"]({
    args: [],
    flags: deployFlags(p.id),
    raw: { name: "api", runtime: "deno", start: "deno task start" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 0);
  assertEquals(client.calls.updateResource[0][2].server, undefined);
});

Deno.test("backend deploy refuses to guess between two computes under --json", async () => {
  const client = reportRunning(createMockCloudClient());
  const p = await client.createProject("app");
  withComputes(client, [
    { id: "srv1", name: "pro-1", location: "GRA" },
    { id: "srv2", name: "pro-2", location: "SBG" },
  ]);
  const cwd = seedSource();
  const cmds = makeBackendCommands(backendDeps(client, cwd, p.id));
  await assertRejects(
    () =>
      cmds["cloud backend deploy"]({
        args: [],
        flags: deployFlags(p.id),
        raw: { name: "api", runtime: "deno", start: "deno task start" },
      }),
    Error,
    "--compute",
  );
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("backend deploy refuses to create a backend that cannot start", async () => {
  // Creating one anyway produces a record the platform reports as
  // deploymentFailed, which the user then has to find and delete by hand.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seedSource();
  Deno.writeTextFileSync(`${cwd}/deno.json`, "{}"); // deno, but no start task
  const cmds = makeBackendCommands(backendDeps(client, cwd, p.id));
  await assertRejects(
    () =>
      cmds["cloud backend deploy"]({
        args: [],
        flags: deployFlags(p.id),
        raw: { name: "api" },
      }),
    Error,
    "--start",
  );
  assertEquals(client.calls.createResource.length, 0);
});
