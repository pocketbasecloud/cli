import { assertEquals, assertRejects } from "@std/assert";
import { makeFrontendCommands } from "../../../src/commands/frontend.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { CliError } from "../../../src/errors.ts";

function deps(
  client = createMockCloudClient(),
  currentProject = "",
): CloudCmdDeps {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
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

/** A pb.json bound to `fe` under production, in the deps' cwd. */
async function bind(
  d: CloudCmdDeps,
  projectId: string,
  entries: Record<string, { id: string; name: string }>,
  defaultEnvironment = "production",
): Promise<void> {
  await Deno.writeTextFile(
    `${d.cwd()}/pb.json`,
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
  const file = JSON.parse(await Deno.readTextFile(`${d.cwd()}/pb.json`));
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
  const file = JSON.parse(await Deno.readTextFile(`${d.cwd()}/pb.json`));
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
  const file = JSON.parse(await Deno.readTextFile(`${d.cwd()}/pb.json`));
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
  const file = JSON.parse(await Deno.readTextFile(`${d.cwd()}/pb.json`));
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
  const file = JSON.parse(await Deno.readTextFile(`${d.cwd()}/pb.json`));
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
    "Pass --name to create the first frontend.",
  );
});

/** The fields a create must carry, as the collection and hooks demand them. */
Deno.test("creating a frontend sends the owner, subdomain, and status", async () => {
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
  assertEquals(data.subdomain, "my-site");
  assertEquals(data.status, "pending");
  assertEquals(data.name, "My Site");
});

Deno.test("--subdomain wins over the name", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  await makeFrontendCommands(d)["cloud frontend deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "web", subdomain: "tom-web", "skip-build": true },
  });
  assertEquals(client.calls.createResource[0][1].subdomain, "tom-web");
});

Deno.test("an invalid --subdomain is rejected before anything is built", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  await assertRejects(
    () =>
      makeFrontendCommands(d)["cloud frontend deploy"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { name: "web", subdomain: "Not_Valid", "skip-build": true },
      }),
    Error,
    'Invalid --subdomain "Not_Valid"',
  );
  assertEquals(client.calls.createResource.length, 0);
});

/** PocketBase's answer when the unique index on `subdomain` rejects a create. */
const taken = () =>
  new CliError("Platform error (400): Failed to create record.", 1, {
    subdomain: "validation_not_unique",
  });

Deno.test("a taken subdomain is retried once with a suffix", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  runningNow(client);
  const create = client.createResource.bind(client);
  let attempts = 0;
  client.createResource = (kind, data) => {
    if (++attempts === 1) return Promise.reject(taken());
    return create(kind, data);
  };
  const code = await makeFrontendCommands(d)["cloud frontend deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "web", "skip-build": true },
  });
  assertEquals(code, 0);
  assertEquals(attempts, 2);
  // Only the second attempt reached the mock's recorder.
  assertEquals(client.calls.createResource.length, 1);
  const retried = client.calls.createResource[0][1].subdomain as string;
  assertEquals(retried.startsWith("web-"), true);
  assertEquals(retried !== "web", true);
});

Deno.test("a taken explicit --subdomain is reported, not worked around", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const d = deps(client, p.id);
  Deno.writeTextFileSync(`${d.cwd()}/index.html`, "<html></html>");
  client.createResource = () => Promise.reject(taken());
  await assertRejects(
    () =>
      makeFrontendCommands(d)["cloud frontend deploy"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { name: "web", subdomain: "taken", "skip-build": true },
      }),
    Error,
    'Subdomain "taken" is already taken',
  );
});

Deno.test("a redeploy leaves the owner and subdomain alone", async () => {
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
    `${d.cwd()}/pb.json`,
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
    "pb.json is bound to backends — deploy frontends from a different",
  );
});
