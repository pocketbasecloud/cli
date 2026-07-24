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
  assertEquals(
    (client.calls.ext[0][1] as { frontendId: string }).frontendId,
    fe.id,
  );
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
