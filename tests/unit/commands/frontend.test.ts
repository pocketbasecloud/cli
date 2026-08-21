import { assertEquals, assertRejects } from "@std/assert";
import { makeFrontendCommands } from "../../../src/commands/frontend.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";

function deps(
  client = createMockCloudClient(),
  currentProject = "",
): CloudCmdDeps {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject,
  };
  // An isolated cwd so resource-binding writes don't pollute a shared /tmp.
  const cwd = Deno.makeTempDirSync();
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
  };
}

Deno.test("frontend domain add posts to custom-domain/add", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const fe = await client.createResource("frontends", {
    name: "site",
    project: p.id,
  });
  const cmds = makeFrontendCommands(deps(client, p.id));
  const code = await cmds["cloud frontend domain add"]({
    args: ["example.com"],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
    raw: { name: "site" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.ext[0][0], "/api/frontends/custom-domain/add");
  const body = client.calls.ext[0][1] as {
    frontend_id: string;
    custom_domain: string;
  };
  assertEquals(body.frontend_id, fe.id);
  // The controller reads custom_domain; "domain" was silently ignored.
  assertEquals(body.custom_domain, "example.com");
});

/** A pbc.json bound to `fe` under production, in the deps' cwd. */
async function bind(
  d: CloudCmdDeps,
  projectId: string,
  entries: Record<string, { id: string; name: string }>,
  defaultEnvironment = "production",
): Promise<void> {
  await Deno.writeTextFile(
    `${d.cwd()}/pbc.json`,
    JSON.stringify({
      projectId,
      kind: "frontends",
      defaultEnvironment,
      environments: entries,
    }),
  );
}

const flags = (over: Record<string, unknown> = {}) => ({
  json: true,
  yes: true,
  noInput: true,
  interactive: false,
  ...over,
});

/** Report every polled resource as running so deploy reaches its terminal state. */
const runningNow = (client: ReturnType<typeof createMockCloudClient>) => {
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
};

Deno.test("frontend deploy --env creates a second resource, leaving the first bound", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const fe = await client.createResource("frontends", {
    name: "web",
    project: p.id,
  });
  const d = deps(client, p.id);
  await bind(d, p.id, { production: { id: fe.id, name: "web" } });
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  const code = await makeFrontendCommands(d)["cloud frontend deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { env: "staging", name: "web-staging", "skip-build": true },
  });
  assertEquals(code, 0);
  const file = JSON.parse(await Deno.readTextFile(`${d.cwd()}/pbc.json`));
  assertEquals(file.environments.production, { id: fe.id, name: "web" });
  assertEquals(file.environments.staging.name, "web-staging");
  assertEquals(file.defaultEnvironment, "production");
});

Deno.test("a stale binding clears only its own environment", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const fe = await client.createResource("frontends", {
    name: "web",
    project: p.id,
  });
  const d = deps(client, p.id);
  await bind(d, p.id, {
    production: { id: fe.id, name: "web" },
    staging: { id: "gone", name: "web-staging" },
  });
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  await assertRejects(
    () =>
      makeFrontendCommands(d)["cloud frontend deploy"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { env: "staging", "skip-build": true },
      }),
    Error,
    'Bound frontends gone (environment "staging") no longer exists',
  );
  const file = JSON.parse(await Deno.readTextFile(`${d.cwd()}/pbc.json`));
  assertEquals(file.environments, { production: { id: fe.id, name: "web" } });
});

/**
 * Drive the real handler through its own prompts: it reads stdin directly, so
 * a TTY has to be faked to reach the path a user actually gets.
 */
async function withTTY<T>(answers: string[], fn: () => Promise<T>): Promise<T> {
  const isTerminal = Deno.stdin.isTerminal;
  const read = Deno.stdin.read;
  const queue = [...answers];
  try {
    Deno.stdin.isTerminal = () => true;
    Deno.stdin.read = (buf: Uint8Array) => {
      const next = queue.shift();
      if (next === undefined) return Promise.resolve(null);
      const bytes = new TextEncoder().encode(`${next}\n`);
      buf.set(bytes);
      return Promise.resolve(bytes.length);
    };
    return await fn();
  } finally {
    Deno.stdin.isTerminal = isTerminal;
    Deno.stdin.read = read;
  }
}

Deno.test("a bare deploy asks for a name and creates the frontend", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  // "" accepts the default environment; then the name.
  const code = await withTTY(
    ["", "web"],
    () =>
      makeFrontendCommands(d)["cloud frontend deploy"]({
        args: [],
        flags: flags({ project: p.id, json: false, noInput: false }),
        raw: { "skip-build": true },
      }),
  );
  assertEquals(code, 0);
  const sites = await client.listResources("frontends", p.id);
  assertEquals(sites.map((s) => s.name), ["web"]);
  const file = JSON.parse(await Deno.readTextFile(`${d.cwd()}/pbc.json`));
  assertEquals(file.environments.production.name, "web");
});

Deno.test("a bare deploy can pick an existing frontend to redeploy", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const fe = await client.createResource("frontends", {
    name: "web",
    project: p.id,
  });
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  // "" accepts the default environment; "1" is the existing site ("2" would
  // have been "Create a new frontend…").
  const code = await withTTY(
    ["", "1"],
    () =>
      makeFrontendCommands(d)["cloud frontend deploy"]({
        args: [],
        flags: flags({ project: p.id, json: false, noInput: false }),
        raw: { "skip-build": true },
      }),
  );
  assertEquals(code, 0);
  const sites = await client.listResources("frontends", p.id);
  assertEquals(sites.map((s) => s.id), [fe.id]);
});

Deno.test("a first deploy records the environment it was told to use", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  const code = await withTTY(
    ["staging", "web"],
    () =>
      makeFrontendCommands(d)["cloud frontend deploy"]({
        args: [],
        flags: flags({ project: p.id, json: false, noInput: false }),
        raw: { "skip-build": true },
      }),
  );
  assertEquals(code, 0);
  const file = JSON.parse(await Deno.readTextFile(`${d.cwd()}/pbc.json`));
  assertEquals(Object.keys(file.environments), ["staging"]);
  assertEquals(file.defaultEnvironment, "staging");
});

Deno.test("a directory that already names an environment is not asked again", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const fe = await client.createResource("frontends", {
    name: "web",
    project: p.id,
  });
  const d = deps(client, p.id);
  await bind(d, p.id, { production: { id: fe.id, name: "web" } });
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  // One answer in the queue, and nothing should consume it.
  const code = await withTTY(
    ["staging"],
    () =>
      makeFrontendCommands(d)["cloud frontend deploy"]({
        args: [],
        flags: flags({ project: p.id, json: false, noInput: false }),
        raw: { "skip-build": true },
      }),
  );
  assertEquals(code, 0);
  const file = JSON.parse(await Deno.readTextFile(`${d.cwd()}/pbc.json`));
  assertEquals(Object.keys(file.environments), ["production"]);
});

Deno.test("a bare deploy still errors without a terminal to ask on", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  await assertRejects(
    () =>
      makeFrontendCommands(d)["cloud frontend deploy"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { "skip-build": true },
      }),
    Error,
    "Pass --name to create the first frontend, or",
  );
});

/** The fields a create must carry, as the collection and hooks demand them. */
Deno.test("creating a frontend sends the owner and status, and no subdomain", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  const code = await makeFrontendCommands(d)["cloud frontend deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "My Site", "skip-build": true },
  });
  assertEquals(code, 0);
  const [kind, data] = client.calls.createResource[0];
  assertEquals(kind, "frontends");
  assertEquals(data.user, "u1");
  assertEquals(data.status, "pending");
  assertEquals(data.name, "My Site");
  // The platform assigns <id>.<compute shortKey>; sending one would be a
  // user-chosen address again, and one DNS record per site.
  assertEquals(data.subdomain, undefined);
});

Deno.test("a --subdomain left in a pinned script is ignored, not sent", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  const code = await makeFrontendCommands(d)["cloud frontend deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "web", subdomain: "tom-web", "skip-build": true },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].subdomain, undefined);
});

Deno.test("a redeploy leaves the owner and address alone", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const fe = await client.createResource("frontends", {
    name: "web",
    project: p.id,
  });
  const d = deps(client, p.id);
  await bind(d, p.id, { production: { id: fe.id, name: "web" } });
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  const code = await makeFrontendCommands(d)["cloud frontend deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { "skip-build": true },
  });
  assertEquals(code, 0);
  const [, , data] = client.calls.updateResource[0];
  assertEquals(data.subdomain, undefined);
  assertEquals(data.user, undefined);
  assertEquals(data.status, "uploading");
});

Deno.test("frontend deploy refuses a directory bound to another kind", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  await Deno.writeTextFile(
    `${d.cwd()}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "backends",
      defaultEnvironment: "production",
      environments: { production: { id: "be1", name: "api" } },
    }),
  );
  await assertRejects(
    () =>
      makeFrontendCommands(d)["cloud frontend deploy"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { name: "web" },
      }),
    Error,
    "pbc.json is bound to backends — deploy frontends from a different",
  );
});

/** A mock whose deploy-context reports the project owner's compute. */
function withComputes(
  client: ReturnType<typeof createMockCloudClient>,
  computes: { id: string; name: string; location: string }[],
  context: { ownerPlan?: string; organization?: string } = {},
) {
  client.deployContext = () =>
    Promise.resolve({
      ownerPlan: context.ownerPlan ?? "pro",
      isOwner: true,
      organization: context.organization ?? "",
      servers: computes,
    });
}

Deno.test("creating a frontend uses the owner's Pro compute", async () => {
  // Auto-selection only considers the shared platform pool, so without this a
  // Pro site lands on shared infrastructure instead of the compute paid for.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  withComputes(client, [{ id: "srv9", name: "pro-1", location: "GRA" }]);
  const code = await makeFrontendCommands(d)["cloud frontend deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "web", "skip-build": true },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "srv9");
});

Deno.test("creating a frontend in an org project uses the organization's compute", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  withComputes(client, [{ id: "org-srv", name: "org-1", location: "GRA" }], {
    ownerPlan: "free",
    organization: "org1",
  });
  const code = await makeFrontendCommands(d)["cloud frontend deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "web", "skip-build": true },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "org-srv");
});

Deno.test("a frontend redeploy never re-picks the compute", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("frontends", { name: "web", project: p.id });
  client.calls.createResource.length = 0; // seeding is not the deploy's doing
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  client.deployContext = () => {
    throw new Error("deploy-context must not be called on a redeploy");
  };
  const code = await makeFrontendCommands(d)["cloud frontend deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "web", "skip-build": true },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 0);
  assertEquals(client.calls.updateResource[0][2].server, undefined);
});

function captureLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.log = original };
}

Deno.test("frontend ls announces the project resolved from config.currentProject", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cmds = makeFrontendCommands(deps(client, p.id));
  const log = captureLog();
  try {
    const code = await cmds["cloud frontend ls"]({
      args: [],
      flags: flags({ json: false }),
      raw: {},
    });
    assertEquals(code, 0);
    assertEquals(log.lines[0].includes(`Project: ${p.name}`), true);
    assertEquals(log.lines[0].includes("pbc cloud project use"), true);
  } finally {
    log.restore();
  }
});

Deno.test("frontend ls does not announce the project when --project names it", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cmds = makeFrontendCommands(deps(client, p.id));
  const log = captureLog();
  try {
    await cmds["cloud frontend ls"]({
      args: [],
      flags: flags({ json: false, project: p.id }),
      raw: {},
    });
    assertEquals(log.lines.some((l) => l.startsWith("Project:")), false);
  } finally {
    log.restore();
  }
});
