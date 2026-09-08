import { assertEquals, assertRejects } from "@std/assert";
import { makeBackendCommands } from "../../../src/commands/backend.ts";
import { makeResourceCommands } from "../../../src/commands/resource.ts";
import { KINDS } from "../../../src/kinds.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { createMockDeployFetch } from "../../mocks/deployments.mock.ts";
import { tempStatePath } from "../../mocks/state.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { PromptIO } from "../../../src/ui/prompt.ts";

function seedSource(): string {
  const cwd = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${cwd}/main.ts`, "console.log(1);\n");
  return cwd;
}

function fakeIO(inputs: string[]): PromptIO {
  const queue = [...inputs];
  return {
    read: () => Promise.resolve(queue.shift() ?? null),
    write: () => {},
    isTTY: true,
  };
}

Deno.test("backend deploy sends runtime and start command", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  withComputes(client, [{ id: "srv1", name: "pro-1", location: "GRA" }]);
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
  const deploy = createMockDeployFetch();
  const cmds = makeBackendCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    envStatePath: tempStatePath(),
    fetch: deploy.fetchFn,
  });
  const code = await cmds["backend deploy"].run({ new: "api", runtime: "deno", start: "deno task start" }, {
      args: [],
      flags: {
        json: true,
        yes: true,
        noInput: true,
        interactive: false,
        project: p.id,
      },
  });
  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.runtime, "deno");
  assertEquals(data.startCommand, "deno task start");
  assertEquals(data.user, "u1");
  assertEquals(data.status, "pending");
});

Deno.test("backend rm keeps a binding it did not resolve", async () => {
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
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "backends",
      defaultEnvironment: "production",
      environments: { production: { id: bound.id, name: "api" } },
    }),
  );
  const code = await makeResourceCommands(d, KINDS.backends)["backend rm"].run({ name: "api-old" }, {
      args: [],
      flags: {
        json: true,
        yes: true,
        noInput: true,
        interactive: false,
        project: p.id,
      },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.updateResource[0][1], other.id);
  const file = JSON.parse(await Deno.readTextFile(`${cwd}/pbc.json`));
  assertEquals(file.environments, {
    production: { id: bound.id, name: "api" },
  });
});

Deno.test("backend deploy forwards --compute, which Pro deploys cannot do without", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  withComputes(client, [{ id: "srv1", name: "pro-1", location: "GRA" }]);
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
  const deploy = createMockDeployFetch();
  await makeBackendCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    envStatePath: tempStatePath(),
    fetch: deploy.fetchFn,
  })["backend deploy"].run({
      new: "api",
      runtime: "deno",
      compute: "srv1",
      start: "deno task start"
  }, {
      args: [],
      flags: {
        json: true,
        yes: true,
        noInput: true,
        interactive: false,
        project: p.id,
      },
  });
  assertEquals(client.calls.createResource[0][1].server, "srv1");
});

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
  const deploy = createMockDeployFetch();
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    envStatePath: tempStatePath(),
    fetch: deploy.fetchFn,
    deploy,
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
  withComputes(client, [{ id: "srv1", name: "pro-1", location: "GRA" }]);
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
  const code = await cmds["backend deploy"].run({ new: "api" }, {
      args: [],
      flags: deployFlags(p.id),
  });
  assertEquals(code, 0);
  assertEquals(
    client.calls.createResource[0][1].startCommand,
    "deno task start",
  );
});

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
  const code = await cmds["backend deploy"].run({ new: "api", runtime: "deno", start: "deno task start" }, {
      args: [],
      flags: deployFlags(p.id),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "srv9");
});

Deno.test("backend deploy works for an org developer on the owner's Pro compute", async () => {
  const client = reportRunning(createMockCloudClient());
  client.whoami = () =>
    Promise.resolve({ id: "dev1", email: "dev@e.com", plan: "free" });
  const p = await client.createProject("app");
  withComputes(client, [{ id: "owner-srv", name: "pro-1", location: "GRA" }], {
    isOwner: false,
  });
  const cwd = seedSource();
  const cmds = makeBackendCommands(backendDeps(client, cwd, p.id));
  const code = await cmds["backend deploy"].run({ new: "api", runtime: "deno", start: "deno task start" }, {
      args: [],
      flags: deployFlags(p.id),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "owner-srv");
});

Deno.test("backend deploy errors when the only project cannot host a backend", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("solo");
  const cwd = seedSource();
  const cmds = makeBackendCommands(backendDeps(client, cwd, p.id));
  await assertRejects(
    () =>
      cmds["backend deploy"].run({
        new: "api",
        runtime: "deno",
        start: "deno task start",
      }, {
        args: [],
        flags: deployFlags(p.id),
      }),
    Error,
    "cannot host a backend",
  );
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("backend deploy tells a non-interactive caller to pass --project", async () => {
  const client = createMockCloudClient();
  const free = await client.createProject("personal");
  const pro = await client.createProject("team");
  client.deployContext = (projectId?: string) =>
    Promise.resolve({
      ownerPlan: projectId === pro.id ? "pro" : "free",
      isOwner: true,
      organization: "",
      servers: [],
    });
  const cwd = seedSource();
  const cmds = makeBackendCommands(backendDeps(client, cwd, free.id));
  await assertRejects(
    () =>
      cmds["backend deploy"].run({
        new: "api",
        runtime: "deno",
        start: "deno task start",
      }, {
        args: [],
        flags: deployFlags(free.id),
      }),
    Error,
    "--project",
  );
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("backend deploy lets an interactive user switch to a Pro project", async () => {
  const client = reportRunning(createMockCloudClient());
  const free = await client.createProject("personal");
  const pro = await client.createProject("team");
  client.deployContext = (projectId?: string) =>
    Promise.resolve({
      ownerPlan: projectId === pro.id ? "pro" : "free",
      isOwner: true,
      organization: "",
      servers: projectId === pro.id
        ? [{ id: "team-srv", name: "pro-1", location: "GRA" }]
        : [],
    });
  const cwd = seedSource();
  const cmds = makeBackendCommands({
    ...backendDeps(client, cwd, free.id),
    io: fakeIO(["1"]),
  });
  const code = await cmds["backend deploy"].run({
    new: "api",
    runtime: "deno",
    start: "deno task start",
    env: "production",
  }, {
    args: [],
    flags: { json: false, yes: true, noInput: false, interactive: true },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 1);
  assertEquals(client.calls.createResource[0][1].project, pro.id);
  assertEquals(client.calls.createResource[0][1].server, "team-srv");
});

Deno.test("backend redeploy never re-picks the compute", async () => {
  const client = reportRunning(createMockCloudClient());
  const p = await client.createProject("app");
  await client.createResource("backends", { name: "api", project: p.id });
  client.calls.createResource.length = 0;
  client.deployContext = () => {
    throw new Error("deploy-context must not be called on a redeploy");
  };
  const cwd = seedSource();
  const cmds = makeBackendCommands(backendDeps(client, cwd, p.id));
  const code = await cmds["backend deploy"].run({ name: "api", runtime: "deno", start: "deno task start" }, {
      args: [],
      flags: deployFlags(p.id),
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
      cmds["backend deploy"].run({ new: "api", runtime: "deno", start: "deno task start" }, {
          args: [],
          flags: deployFlags(p.id),
      }),
    Error,
    "--compute",
  );
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("backend deploy refuses to create a backend that cannot start", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  withComputes(client, [{ id: "srv1", name: "pro-1", location: "GRA" }]);
  const cwd = seedSource();
  Deno.writeTextFileSync(`${cwd}/deno.json`, "{}");
  const cmds = makeBackendCommands(backendDeps(client, cwd, p.id));
  await assertRejects(
    () =>
      cmds["backend deploy"].run({ new: "api" }, {
          args: [],
          flags: deployFlags(p.id),
      }),
    Error,
    "--start",
  );
  assertEquals(client.calls.createResource.length, 0);
});

function captureLog() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) =>
    lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.error = original };
}

Deno.test("backend ls announces the project resolved from config.currentProject", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seedSource();
  const cmds = makeResourceCommands(backendDeps(client, cwd, p.id), KINDS.backends);
  const log = captureLog();
  try {
    const code = await cmds["backend ls"].run({}, {
        args: [],
        flags: { json: false, yes: true, noInput: true, interactive: false },
    });
    assertEquals(code, 0);
    assertEquals(log.lines[0].includes(`Project: ${p.name}`), true);
    assertEquals(log.lines[0].includes("pbc project use"), true);
  } finally {
    log.restore();
  }
});

Deno.test("backend ls does not announce the project when --project names it", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seedSource();
  const cmds = makeResourceCommands(backendDeps(client, cwd, p.id), KINDS.backends);
  const log = captureLog();
  try {
    await cmds["backend ls"].run({}, {
        args: [],
        flags: {
          json: false,
          yes: true,
          noInput: true,
          interactive: false,
          project: p.id,
        },
    });
    assertEquals(log.lines.some((l) => l.startsWith("Project:")), false);
  } finally {
    log.restore();
  }
});
