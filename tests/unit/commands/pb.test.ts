import { assertEquals, assertRejects } from "@std/assert";
import { makePbCommands } from "../../../src/commands/pb.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import {
  type Config,
  defaultConfig,
  readLinkFile,
} from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";

function deps(
  client = createMockCloudClient(),
  currentProject = "",
): { d: CloudCmdDeps; config: Config; cwd: string } {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject,
  };
  // An isolated cwd so resource-binding writes don't pollute a shared /tmp.
  const cwd = Deno.makeTempDirSync();
  return {
    config,
    cwd,
    d: {
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => cwd,
    },
  };
}

const runningNow = (client: ReturnType<typeof createMockCloudClient>) => {
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
};

const flags = (over: Record<string, unknown> = {}) => ({
  json: true,
  yes: true,
  noInput: true,
  interactive: false,
  ...over,
});

Deno.test("pb deploy creates then reaches running, recording the binding", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config, cwd } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  const cmds = makePbCommands(d);
  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 1);
  // Deploy recorded the new resource in the directory's pb.json.
  const link = await readLinkFile(cwd);
  assertEquals(link?.resource, {
    kind: "pocketbases",
    id: (await client.listResources("pocketbases", p.id))[0].id,
    name: "db1",
  });
});

Deno.test("bare pb deploy redeploys the bound resource with no --name", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const { d, config, cwd } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  // Pre-bind the directory to the existing resource.
  await Deno.writeTextFile(
    `${cwd}/pb.json`,
    JSON.stringify({
      projectId: p.id,
      resource: { kind: "pocketbases", id: pb.id, name: "db1" },
    }),
  );
  client.calls.createResource.length = 0; // ignore the seed create above
  const cmds = makePbCommands(d);
  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 0);
  assertEquals(client.calls.updateResource[0][1], pb.id);
});

Deno.test("pb deploy with no name and no binding errors", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  const cmds = makePbCommands(d);
  await assertRejects(
    () =>
      cmds["cloud pb deploy"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: {},
      }),
    Error,
    "Pass --name",
  );
});

Deno.test("pb rm clears the directory binding", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const { d, config, cwd } = deps(client);
  config.currentProject = p.id;
  await Deno.writeTextFile(
    `${cwd}/pb.json`,
    JSON.stringify({
      projectId: p.id,
      resource: { kind: "pocketbases", id: pb.id, name: "db1" },
    }),
  );
  const cmds = makePbCommands(d);
  const code = await cmds["cloud pb rm"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals((await readLinkFile(cwd))?.resource, undefined);
});
