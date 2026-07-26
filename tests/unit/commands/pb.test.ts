import { assertEquals, assertRejects } from "@std/assert";
import { makePbCommands } from "../../../src/commands/pb.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import {
  type Config,
  defaultConfig,
  readLinkFile,
} from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { FALLBACK_VERSIONS } from "../../../src/local/releases.ts";

function deps(
  client = createMockCloudClient(),
  currentProject = "",
): { d: CloudCmdDeps; config: Config; cwd: string } {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject,
  };
  // An isolated cwd so resource-binding writes don't pollute a shared /tmp.
  const cwd = Deno.makeTempDirSync();
  // A hooks directory gives deploy something to package and, on a redeploy,
  // something to push.
  Deno.mkdirSync(`${cwd}/pb_hooks`);
  Deno.writeTextFileSync(`${cwd}/pb_hooks/main.pb.js`, "// hook\n");
  return {
    config,
    cwd,
    d: {
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => cwd,
      // Deploy resolves the newest release when nothing is pinned. Stubbed so
      // the unit suite never touches the network.
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              { tag_name: "v0.39.9", draft: false, prerelease: false },
              { tag_name: "v0.39.8", draft: false, prerelease: false },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      env: () => undefined,
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
  // `user` is required by the collection and is what the slot check reads.
  assertEquals(client.calls.createResource[0][1].user, "u1");
  // Deploy recorded the new resource in the directory's pb.json, under the
  // environment it created and made the default.
  const link = await readLinkFile(cwd);
  assertEquals(link?.kind, "pocketbases");
  assertEquals(link?.defaultEnvironment, "production");
  assertEquals(link?.environments, {
    production: {
      id: (await client.listResources("pocketbases", p.id))[0].id,
      name: "db1",
    },
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
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1" } },
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

Deno.test("pb rm clears that environment's binding", async () => {
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
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1" } },
    }),
  );
  const cmds = makePbCommands(d);
  const code = await cmds["cloud pb rm"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: {},
  });
  assertEquals(code, 0);
  const link = await readLinkFile(cwd);
  assertEquals(link?.environments, undefined);
  // The last environment took `kind` with it, but not the project.
  assertEquals(link?.kind, undefined);
  assertEquals(link?.projectId, p.id);
});

Deno.test("pb deploy --env records a second environment beside the first", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const { d, config, cwd } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  await Deno.writeTextFile(
    `${cwd}/pb.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1" } },
    }),
  );
  const cmds = makePbCommands(d);
  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { env: "staging", name: "db1-staging" },
  });
  assertEquals(code, 0);
  const link = await readLinkFile(cwd);
  assertEquals(link?.defaultEnvironment, "production");
  assertEquals(link?.environments?.production, { id: pb.id, name: "db1" });
  assertEquals(link?.environments?.staging.name, "db1-staging");
});

Deno.test("pb deploy --env on an unconfigured environment demands --name", async () => {
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
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1" } },
    }),
  );
  const cmds = makePbCommands(d);
  await assertRejects(
    () =>
      cmds["cloud pb deploy"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { env: "staging" },
      }),
    Error,
    'Environment "staging" is not configured — pass --name to create it.',
  );
});

Deno.test("pb deploy sends admin credentials, which the platform will not invent", async () => {
  // PocketBaseService.handleAfterCreateHook fails the deploy outright when
  // either is blank, and nothing on the platform fills them in.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config, cwd } = deps(client);
  config.currentProject = p.id;
  Deno.writeTextFileSync(
    `${cwd}/pb.json`,
    JSON.stringify({ pocketbaseVersion: "0.39.3" }),
  );
  runningNow(client);
  await d.requireAuth();
  const code = await makePbCommands(d)["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
  });
  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.adminUsername, "u@e.com");
  assertEquals(String(data.adminPassword).length, 20);
  // The directory's pin says which build was developed against.
  assertEquals(data.version, "0.39.3");
});

Deno.test("pb deploy honours explicit admin flags and rejects an unusable password", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  await makePbCommands(d)["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: {
      name: "db1",
      "admin-email": "ops@e.com",
      "admin-password": "correcthorsebattery",
    },
  });
  const [, data] = client.calls.createResource[0];
  assertEquals(data.adminUsername, "ops@e.com");
  assertEquals(data.adminPassword, "correcthorsebattery");

  const two = deps(client);
  two.config.currentProject = p.id;
  await assertRejects(
    () =>
      makePbCommands(two.d)["cloud pb deploy"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { name: "db2", "admin-password": "short" },
      }),
    Error,
    "--admin-password must be 12 to 20 characters.",
  );
});

Deno.test("pb deploy always sends a version, even with nothing pinned", async () => {
  // An empty `version` reaches the agent as "install PocketBase ''", which
  // strands the instance in `creating` forever with no error status. The
  // create path must never send one.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  const cmds = makePbCommands(d);
  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" }, // no --pb-version, and the cwd has no pb.json pin
  });
  assertEquals(code, 0);
  const sent = client.calls.createResource[0][1].version;
  assertEquals(typeof sent, "string");
  assertEquals((sent as string).length > 0, true);
});

Deno.test("an explicit --pb-version still wins over the resolved default", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  const cmds = makePbCommands(d);
  await cmds["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1", "pb-version": "0.30.0" },
  });
  assertEquals(client.calls.createResource[0][1].version, "0.30.0");
});

Deno.test("pb deploy falls back to a built-in version when the releases API is down", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  d.fetch = () => Promise.reject(new Error("offline"));
  runningNow(client);
  const cmds = makePbCommands(d);
  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
  });
  assertEquals(code, 0);
  // Not asserting a specific number — only that no network means no empty
  // version, which is the failure that strands the instance.
  assertEquals(client.calls.createResource[0][1].version, FALLBACK_VERSIONS[0]);
});
