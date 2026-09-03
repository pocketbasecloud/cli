import { assertEquals, assertRejects } from "@std/assert";
import { makePbCommands, pushHooks } from "../../../src/commands/pb.ts";
import { makeResourceCommands } from "../../../src/commands/resource.ts";
import { KINDS } from "../../../src/kinds.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import {
  createMockDeployFetch,
  type MockDeployFetch,
} from "../../mocks/deployments.mock.ts";
import { tempStatePath } from "../../mocks/state.mock.ts";
import {
  type Config,
  defaultConfig,
  readLinkFile,
} from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { CliError } from "../../../src/errors.ts";
import { suggestName } from "../../../src/commands/deploy-helper.ts";
import type { PromptIO } from "../../../src/ui/prompt.ts";
import { FALLBACK_VERSIONS } from "../../../src/local/releases.ts";
import { extractEntry } from "../../../src/local/unzip.ts";

function deps(
  client = createMockCloudClient(),
  currentProject = "",
): { d: CloudCmdDeps & { deploy: MockDeployFetch }; config: Config; cwd: string } {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject,
  };
  const cwd = Deno.makeTempDirSync();
  Deno.mkdirSync(`${cwd}/pb_hooks`);
  Deno.writeTextFileSync(`${cwd}/pb_hooks/main.pb.js`, "// hook\n");
  const releases = () =>
    Promise.resolve(
      new Response(
        JSON.stringify([
          { tag_name: "v0.39.9", draft: false, prerelease: false },
          { tag_name: "v0.39.8", draft: false, prerelease: false },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const deploy = createMockDeployFetch({ fallback: releases });
  return {
    config,
    cwd,
    d: {
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => cwd,
      envStatePath: tempStatePath(),
      fetch: deploy.fetchFn,
      deploy,
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

function fakeIO(inputs: string[]): PromptIO {
  const q = [...inputs];
  return {
    read: () => Promise.resolve(q.shift() ?? null),
    write: () => {},
    isTTY: true,
  };
}

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
  const code = await cmds["pocketbase deploy"].run({ new: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 1);
  assertEquals(client.calls.createResource[0][1].user, "u1");
  const link = await readLinkFile(cwd);
  assertEquals(link?.kind, "pocketbases");
  assertEquals(link?.defaultEnvironment, "production");
  assertEquals(link?.environments, {
    production: {
      id: (await client.listResources("pocketbases", { project: p.id }))[0].id,
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
  await Deno.writeTextFile(
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1" } },
    }),
  );
  client.calls.createResource.length = 0;
  const cmds = makePbCommands(d);
  const code = await cmds["pocketbase deploy"].run({}, {
    args: [],
    flags: flags({ project: p.id }),
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
      cmds["pocketbase deploy"].run({}, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    Error,
    "--new <name>",
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
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1" } },
    }),
  );
  const code = await makeResourceCommands(d, KINDS.pocketbases)["pocketbase rm"].run({}, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  const link = await readLinkFile(cwd);
  assertEquals(link?.environments, undefined);
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
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1" } },
    }),
  );
  const cmds = makePbCommands(d);
  const code = await cmds["pocketbase deploy"].run({
    env: "staging",
    new: "db1-staging",
  }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  const link = await readLinkFile(cwd);
  assertEquals(link?.defaultEnvironment, "production");
  assertEquals(link?.environments?.production, { id: pb.id, name: "db1" });
  assertEquals(link?.environments?.staging.name, "db1-staging");
});

Deno.test("pb deploy --env on an unconfigured environment demands a target", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const { d, config, cwd } = deps(client);
  config.currentProject = p.id;
  await Deno.writeTextFile(
    `${cwd}/pbc.json`,
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
      cmds["pocketbase deploy"].run({ env: "staging" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    Error,
    "--new <name>",
  );
});

Deno.test("pb deploy sends admin credentials, which the platform will not invent", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config, cwd } = deps(client);
  config.currentProject = p.id;
  Deno.writeTextFileSync(
    `${cwd}/pbc.json`,
    JSON.stringify({ pocketbaseVersion: "0.39.3" }),
  );
  runningNow(client);
  await d.requireAuth();
  const code = await makePbCommands(d)["pocketbase deploy"].run({ new: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.adminUsername, "u@e.com");
  assertEquals(String(data.adminPassword).length, 20);
  assertEquals(data.version, "0.39.3");
});

Deno.test("pb deploy honours explicit admin flags and rejects an unusable password", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  await makePbCommands(d)["pocketbase deploy"].run({
    new: "db1",
    adminEmail: "ops@e.com",
    adminPassword: "correcthorsebattery",
  }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  const [, data] = client.calls.createResource[0];
  assertEquals(data.adminUsername, "ops@e.com");
  assertEquals(data.adminPassword, "correcthorsebattery");

  const two = deps(client);
  two.config.currentProject = p.id;
  await assertRejects(
    () =>
      makePbCommands(two.d)["pocketbase deploy"].run({
        new: "db2",
        adminPassword: "short",
      }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    Error,
    "--admin-password must be 12 to 20 characters.",
  );
});

Deno.test("pb deploy always sends a version, even with nothing pinned", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  const cmds = makePbCommands(d);
  const code = await cmds["pocketbase deploy"].run({ new: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
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
  await cmds["pocketbase deploy"].run({ new: "db1", pbVersion: "0.30.0" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(client.calls.createResource[0][1].version, "0.30.0");
});

Deno.test("pb deploy falls back to a built-in version when the releases API is down", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  d.deploy = createMockDeployFetch({
    fallback: () => Promise.reject(new Error("offline")),
  });
  d.fetch = d.deploy.fetchFn;
  runningNow(client);
  const cmds = makePbCommands(d);
  const code = await cmds["pocketbase deploy"].run({ new: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].version, FALLBACK_VERSIONS[0]);
});

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

Deno.test("pb deploy creates on the owner's Pro compute, which is never auto-selected", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  withComputes(client, [{ id: "srv9", name: "pro-1", location: "GRA" }]);
  const code = await makePbCommands(d)["pocketbase deploy"].run({ new: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "srv9");
});

Deno.test("pb deploy in an org project uses the organization's compute", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  withComputes(client, [{ id: "org-srv", name: "org-1", location: "GRA" }], {
    ownerPlan: "starter",
    organization: "org1",
  });
  const code = await makePbCommands(d)["pocketbase deploy"].run({ new: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "org-srv");
});

Deno.test("pb deploy refuses to guess between two computes under --json", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  withComputes(client, [
    { id: "srv1", name: "pro-1", location: "GRA" },
    { id: "srv2", name: "pro-2", location: "SBG" },
  ]);
  await assertRejects(
    () =>
      makePbCommands(d)["pocketbase deploy"].run({ new: "db1" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    Error,
    "--compute",
  );
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb deploy forwards --compute", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  client.deployContext = () => {
    throw new Error("a named compute must not be second-guessed");
  };
  const code = await makePbCommands(d)["pocketbase deploy"].run(
    { new: "db1", compute: "srv1" },
    {
      args: [],
      flags: flags({ project: p.id }),
    },
  );
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "srv1");
});

Deno.test("pb redeploy never re-picks the compute", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db1", project: p.id });
  client.calls.createResource.length = 0;
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  client.deployContext = () => {
    throw new Error("deploy-context must not be called on a redeploy");
  };
  const code = await makePbCommands(d)["pocketbase deploy"].run({ name: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 0);
});

function hooksDir(files: Record<string, string>): string {
  const dir = Deno.makeTempDirSync();
  for (const [name, content] of Object.entries(files)) {
    Deno.writeTextFileSync(`${dir}/${name}`, content);
  }
  return dir;
}

function pushedNames(
  client: ReturnType<typeof createMockCloudClient>,
): string[] {
  const call = client.calls.pbApi.find(([p]) => p === "/api/hooks/bulk-write");
  if (!call) return [];
  const body = call[1] as { hooks: { filename: string }[] };
  return body.hooks.map((h) => h.filename).sort();
}

Deno.test("pb runtime surfaces expose only supported fields", () => {
  const commands = makePbCommands(deps().d);
  assertEquals(
    Object.keys(commands["pocketbase config set"].flags),
    ["name", "dev", "hooksPool", "queryTimeout"],
  );

  const createFlags = Object.keys(commands["pocketbase create"].flags);
  for (
    const field of [
      "automigrate",
      "dir",
      "encryptionEnv",
      "hooksDir",
      "hooksWatch",
      "indexFallback",
      "migrationsDir",
      "publicDir",
    ]
  ) {
    assertEquals(createFlags.includes(field), false);
  }
  for (const field of ["dev", "hooksPool", "queryTimeout"]) {
    assertEquals(createFlags.includes(field), true);
  }
});

Deno.test("pb config get returns only supported fields", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const resource = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  resource.runtimeFlags = {
    automigrate: false,
    dev: true,
    hooksPool: 20,
    publicDir: "site",
    queryTimeout: 45,
  };
  const { d } = deps(client);
  const log = captureLog();
  try {
    await makePbCommands(d)["pocketbase config get"].run({ name: "db1" }, {
      args: [],
      flags: flags({ project: p.id }),
    });
  } finally {
    log.restore();
  }
  assertEquals(JSON.parse(log.lines.at(-1)!).data, {
    dev: true,
    hooksPool: 20,
    queryTimeout: 45,
  });
});

Deno.test("pb config set returns only supported fields and preserves the rest", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const resource = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  resource.runtimeFlags = {
    dev: false,
    hooksPool: 15,
    publicDir: "site",
    queryTimeout: 30,
  };
  const { d } = deps(client);
  const log = captureLog();
  try {
    await makePbCommands(d)["pocketbase config set"].run({
      name: "db1",
      dev: "true",
    }, {
      args: [],
      flags: flags({ project: p.id }),
    });
  } finally {
    log.restore();
  }
  const request = client.calls.ext.at(-1)?.[1] as {
    runtimeFlags: Record<string, boolean | number | string>;
  };
  assertEquals(request.runtimeFlags.publicDir, "site");
  assertEquals(JSON.parse(log.lines.at(-1)!).data, {
    dev: true,
    hooksPool: 15,
    queryTimeout: 30,
  });
});

Deno.test("pb create presents backup restore as an advanced option", () => {
  const command = makePbCommands(deps().d)["pocketbase create"];
  assertEquals(command.summary, "Create a PocketBase instance.");
  assertEquals(command.usage.endsWith("[--backup <zip>]"), true);
  assertEquals(command.details?.includes("Advanced configuration:"), true);
});

Deno.test("pb create makes a running instance and sends no archive", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const code = await makePbCommands(d)["pocketbase create"].run({ name: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 1);
  const [kind, data] = client.calls.createResource[0];
  assertEquals(kind, "pocketbases");
  assertEquals(data.name, "db1");
  assertEquals(data.project, p.id);
  assertEquals(data.user, "u1");
  assertEquals(data.status, "creating");
  assertEquals(data.zipFile, undefined);
  assertEquals(data.zipFileSize, undefined);
  assertEquals(data.adminUsername, "u@e.com");
  assertEquals(typeof data.adminPassword, "string");
  assertEquals((data.adminPassword as string).length, 20);
  assertEquals(typeof data.version, "string");
  assertEquals((data.version as string).length > 0, true);
});

Deno.test("pb create records the instance in pbc.json", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  runningNow(client);
  await makePbCommands(d)["pocketbase create"].run({ name: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  const link = await readLinkFile(cwd);
  assertEquals(link?.projectId, p.id);
  assertEquals(link?.kind, "pocketbases");
  assertEquals(link?.defaultEnvironment, "production");
  assertEquals(link?.environments, {
    production: {
      id: (await client.listResources("pocketbases", { project: p.id }))[0].id,
      name: "db1",
    },
  });
  assertEquals(
    "envFile" in (link?.environments?.production ?? {}),
    false,
  );
  assertEquals(link?.build, undefined);
});

Deno.test("pb create records under --env, leaving the default alone", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  runningNow(client);
  await Deno.writeTextFile(
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: "existing", name: "db-prod" } },
    }),
  );
  const code = await makePbCommands(d)["pocketbase create"].run({
    name: "db-staging",
    env: "staging",
  }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  const link = await readLinkFile(cwd);
  assertEquals(link?.defaultEnvironment, "production");
  assertEquals(link?.environments?.production, {
    id: "existing",
    name: "db-prod",
  });
  assertEquals(link?.environments?.staging?.name, "db-staging");
});

Deno.test("pb create refuses to repoint an environment that already binds one", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  runningNow(client);
  await Deno.writeTextFile(
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: "bound1", name: "db-prod" } },
    }),
  );
  const err = await assertRejects(
    () =>
      makePbCommands(d)["pocketbase create"].run({ name: "db2" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    CliError,
    "already binds",
  );
  assertEquals(err.exitCode, 2);
  assertEquals(err.message.includes("--env"), true);
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb create refuses a directory bound to another kind", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  runningNow(client);
  await Deno.writeTextFile(
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "frontends",
      defaultEnvironment: "production",
      environments: { production: { id: "fe1", name: "web" } },
    }),
  );
  const err = await assertRejects(
    () =>
      makePbCommands(d)["pocketbase create"].run({ name: "db1" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    CliError,
    "bound to frontends",
  );
  assertEquals(err.exitCode, 2);
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb create records the binding even when provisioning fails", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "error",
  });
  const code = await makePbCommands(d)["pocketbase create"].run({ name: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 6);
  assertEquals(
    (await readLinkFile(cwd))?.environments?.production?.name,
    "db1",
  );
});

Deno.test("pb create takes the name positionally", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const code = await makePbCommands(d)["pocketbase create"].run({}, {
    args: ["db2"],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].name, "db2");
});

Deno.test("pb create refuses a name the project already uses, naming deploy", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  client.calls.createResource.length = 0;
  const { d } = deps(client);
  runningNow(client);
  const err = await assertRejects(
    () =>
      makePbCommands(d)["pocketbase create"].run({ name: "db1" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    CliError,
    "already exists",
  );
  assertEquals(err.code, "CONFLICT");
  assertEquals(err.message.includes("pbc pocketbase deploy --name db1"), true);
  assertEquals(err.message.includes(pb.id), true);
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb create with no name and no terminal says how to pass one", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  const err = await assertRejects(
    () =>
      makePbCommands(d)["pocketbase create"].run({}, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    CliError,
    "pbc pocketbase create <name>",
  );
  assertEquals(err.exitCode, 2);
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb create asks for a name on a terminal, defaulting to the directory", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  runningNow(client);
  d.io = fakeIO(["", ""]);
  const code = await makePbCommands(d)["pocketbase create"].run({}, {
    args: [],
    flags: flags({ project: p.id, json: false, noInput: false }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].name, suggestName(cwd));
  assertEquals((await readLinkFile(cwd))?.defaultEnvironment, "production");
});

Deno.test("pb create records the environment answered on a terminal", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  runningNow(client);
  d.io = fakeIO(["staging"]);
  const code = await makePbCommands(d)["pocketbase create"].run({}, {
    args: ["db1"],
    flags: flags({ project: p.id, json: false, noInput: false }),
  });
  assertEquals(code, 0);
  const link = await readLinkFile(cwd);
  assertEquals(link?.defaultEnvironment, "staging");
  assertEquals(link?.environments?.staging?.name, "db1");
});

Deno.test("pb create honours the admin flags", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const code = await makePbCommands(d)["pocketbase create"].run({
    name: "db1",
    adminEmail: "ops@example.com",
    adminPassword: "correcthorsebattery",
  }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.adminUsername, "ops@example.com");
  assertEquals(data.adminPassword, "correcthorsebattery");
});

Deno.test("pb create rejects an unusable --admin-password", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  await assertRejects(
    () =>
      makePbCommands(d)["pocketbase create"].run({
        name: "db2",
        adminPassword: "short",
      }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    CliError,
    "12 to 20",
  );
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb create sends an explicit --pb-version", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const code = await makePbCommands(d)["pocketbase create"].run({
    name: "db1",
    pbVersion: "0.30.1",
  }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].version, "0.30.1");
});

Deno.test("pb create forwards --location and --compute", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  client.deployContext = () => {
    throw new Error("a named compute must not be second-guessed");
  };
  const code = await makePbCommands(d)["pocketbase create"].run({
    name: "db1",
    location: "GRA",
    compute: "srv1",
  }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.location, "GRA");
  assertEquals(data.server, "srv1");
});

Deno.test("pb create lands on the owner's Pro compute, which is never auto-selected", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  withComputes(client, [{ id: "srv9", name: "pro-1", location: "GRA" }]);
  const code = await makePbCommands(d)["pocketbase create"].run({ name: "db1" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "srv9");
});

Deno.test("pb create prints the generated login once, and where it was recorded", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const log = captureLog();
  try {
    const code = await makePbCommands(d)["pocketbase create"].run(
      { name: "db1" },
      {
        args: [],
        flags: flags({ project: p.id, json: false }),
      },
    );
    assertEquals(code, 0);
  } finally {
    log.restore();
  }
  const password = client.calls.createResource[0][1].adminPassword as string;
  assertEquals(
    log.lines.some((l) => l.includes(`u@e.com / ${password}`)),
    true,
  );
  assertEquals(
    log.lines.some((l) =>
      l.includes('Recorded in pbc.json as environment "production"')
    ),
    true,
  );
});

Deno.test("pb create with a backup explains that credentials are preserved", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const backup = `${d.cwd()}/backup.zip`;
  await Deno.writeFile(backup, new Uint8Array([1, 2, 3]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response(null, { status: 200 }));
  const originalExt = client.ext;
  client.ext = (path, body) => {
    if (path === "/api/pocketbases/backup-upload-url") {
      client.calls.ext.push([path, body]);
      return Promise.resolve(
        Response.json({ data: { key: "backup-key", uploadUrl: "https://upload", maxMB: 150 } }),
      );
    }
    return originalExt(path, body);
  };
  const log = captureLog();
  try {
    const code = await makePbCommands(d)["pocketbase create"].run({
      name: "restored",
      backup,
    }, {
      args: [],
      flags: flags({ project: p.id, json: false }),
    });
    assertEquals(code, 0);
  } finally {
    log.restore();
    globalThis.fetch = originalFetch;
  }
  assertEquals(
    log.lines.some((line) =>
      line.includes("Admin login: preserved from backup; credentials are not available")
    ),
    true,
  );
  assertEquals(
    log.lines.some((line) =>
      line.includes('Recorded in pbc.json as environment "production"')
    ),
    true,
  );
  assertEquals(client.calls.createResource[0][1].adminUsername, undefined);
  assertEquals(client.calls.createResource[0][1].adminPassword, undefined);
});

Deno.test("pb create --json prints the instance with its credentials", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const log = captureLog();
  try {
    await makePbCommands(d)["pocketbase create"].run({ name: "db1" }, {
      args: [],
      flags: flags({ project: p.id }),
    });
  } finally {
    log.restore();
  }
  const out = JSON.parse(log.lines.at(-1) as string).data;
  assertEquals(out.name, "db1");
  assertEquals(out.status, "running");
  assertEquals(out.adminUsername, "u@e.com");
  assertEquals(
    out.adminPassword,
    client.calls.createResource[0][1].adminPassword,
  );
});

Deno.test("pushHooks uploads .js and .json, not just *.pb.js", async () => {
  const client = createMockCloudClient();
  const dir = hooksDir({
    "main.pb.js": "// entrypoint\n",
    "helpers.js": "module.exports = {}\n",
    "countries.json": "[]\n",
    "README.md": "not a hook\n",
  });
  const r = await pushHooks(client, "pb1", dir);
  assertEquals(r, { sent: 3, stored: 3 });
  assertEquals(pushedNames(client), [
    "countries.json",
    "helpers.js",
    "main.pb.js",
  ]);
});

Deno.test("pushHooks marks every file active", async () => {
  const client = createMockCloudClient();
  const dir = hooksDir({ "helpers.js": "x\n" });
  await pushHooks(client, "pb1", dir);
  const body = client.calls.pbApi[0][1] as {
    hooks: { active: boolean }[];
  };
  assertEquals(body.hooks.every((h) => h.active === true), true);
});

Deno.test("pushHooks skips subdirectories and says so", async () => {
  const client = createMockCloudClient();
  const dir = hooksDir({ "main.pb.js": "// hook\n" });
  Deno.mkdirSync(`${dir}/lib`);
  Deno.writeTextFileSync(`${dir}/lib/deep.js`, "// unreachable\n");
  const logs: string[] = [];
  const r = await pushHooks(client, "pb1", dir, (m) => logs.push(m));
  assertEquals(r.sent, 1);
  assertEquals(pushedNames(client), ["main.pb.js"]);
  assertEquals(logs.length, 1);
  assertEquals(logs[0].includes("lib/"), true);
});

Deno.test("pushHooks refuses more than 30 files in one push", async () => {
  const client = createMockCloudClient();
  const files: Record<string, string> = {};
  for (let i = 0; i < 31; i++) files[`h${i}.js`] = "// hook\n";
  await assertRejects(
    () => pushHooks(client, "pb1", hooksDir(files)),
    Error,
    "pushes at most 30 at a time",
  );
  assertEquals(client.calls.pbApi.length, 0);
});

Deno.test("pushHooks accepts a directory sitting exactly on the limit", async () => {
  const client = createMockCloudClient();
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`h${i}.js`] = "// hook\n";
  const r = await pushHooks(client, "pb1", hooksDir(files));
  assertEquals(r.sent, 30);
  assertEquals(client.calls.pbApi.length, 1);
});

Deno.test("pushHooks refuses a file longer than the content limit", async () => {
  const client = createMockCloudClient();
  const dir = hooksDir({
    "checkout.js": "x".repeat(300_001),
    "helpers.js": "// fine\n",
  });
  await assertRejects(
    () => pushHooks(client, "pb1", dir),
    Error,
    "checkout.js (300,001 characters)",
  );
  assertEquals(client.calls.pbApi.length, 0);
});

Deno.test("pushHooks accepts a file sitting exactly on the content limit", async () => {
  const client = createMockCloudClient();
  const dir = hooksDir({ "checkout.js": "x".repeat(300_000) });
  const r = await pushHooks(client, "pb1", dir);
  assertEquals(r.sent, 1);
  assertEquals(client.calls.pbApi.length, 1);
});

Deno.test("pushHooks repeats the platform's reason on a rejected push", async () => {
  const client = createMockCloudClient();
  client.pbApi = (path, body) => {
    client.calls.pbApi.push([path, body]);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: "Failed to write hooks",
          details:
            "checkout.js is 60,000 characters — the limit is 50,000 per hook file.",
        }),
        { status: 400 },
      ),
    );
  };
  const dir = hooksDir({ "main.pb.js": "// hook\n" });
  await assertRejects(
    () => pushHooks(client, "pb1", dir),
    Error,
    "Hook push failed (400): checkout.js is 60,000 characters — the limit is 50,000 per hook file.",
  );
});

Deno.test("pushHooks falls back to the status code when the body says nothing", async () => {
  const client = createMockCloudClient();
  client.pbApi = (path, body) => {
    client.calls.pbApi.push([path, body]);
    return Promise.resolve(new Response("not json", { status: 502 }));
  };
  const dir = hooksDir({ "main.pb.js": "// hook\n" });
  await assertRejects(
    () => pushHooks(client, "pb1", dir),
    Error,
    "Hook push failed (502).",
  );
});

Deno.test("pushHooks reports what the platform stored, not what it sent", async () => {
  const client = createMockCloudClient();
  client.pbApi = (path, body) => {
    client.calls.pbApi.push([path, body]);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          details: {
            succeeded: 1,
            results: [
              { filename: "helpers.js", status: "success" },
              {
                filename: "main.pb.js",
                status: "failed",
                error_message: "content exceeds maximum size of 1MB",
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
  };
  const dir = hooksDir({ "main.pb.js": "// hook\n", "helpers.js": "x\n" });
  const logs: string[] = [];
  const r = await pushHooks(client, "pb1", dir, (m) => logs.push(m));
  assertEquals(r, { sent: 2, stored: 1 });
  assertEquals(logs.length, 1);
  assertEquals(logs[0].includes("main.pb.js"), true);
  assertEquals(logs[0].includes("exceeds maximum size"), true);
});

Deno.test("pushHooks errors when the directory is missing", async () => {
  await assertRejects(
    () => pushHooks(createMockCloudClient(), "pb1", "/nope/pb_hooks"),
    Error,
    "Hooks directory not found",
  );
});

Deno.test("pb redeploy ships the hook directory's .js helpers in the archive", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const { d, config, cwd } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  Deno.writeTextFileSync(`${cwd}/pb_hooks/helpers.js`, "module.exports = {}\n");
  Deno.writeTextFileSync(`${cwd}/pb_hooks/seed.json`, "[]\n");
  await Deno.writeTextFile(
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1" } },
    }),
  );
  const code = await makePbCommands(d)["pocketbase deploy"].run({}, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  const [, , data] = client.calls.updateResource[0];
  assertEquals(data.zipFile, undefined);
  const put = d.deploy.calls.find((c) => c.url === "https://r2/put");
  const zip = put?.bodyBytes ?? new Uint8Array();
  const dec = new TextDecoder();
  assertEquals(
    dec.decode(await extractEntry(zip, "pb_hooks/helpers.js")),
    "module.exports = {}\n",
  );
  assertEquals(
    dec.decode(await extractEntry(zip, "pb_hooks/seed.json")),
    "[]\n",
  );
  assertEquals(
    dec.decode(await extractEntry(zip, "pb_hooks/main.pb.js")),
    "// hook\n",
  );
  assertEquals(pushedNames(client), []);
});

function captureLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.log = original };
}

function captureErr() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) =>
    lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.error = original };
}

Deno.test("pb ls announces the project resolved from config.currentProject", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  const log = captureErr();
  try {
    const code = await makeResourceCommands(d, KINDS.pocketbases)["pocketbase ls"].run({}, {
      args: [],
      flags: flags({ json: false }),
    });
    assertEquals(code, 0);
    assertEquals(log.lines[0].includes(`Project: ${p.name}`), true);
    assertEquals(log.lines[0].includes("pbc project use"), true);
  } finally {
    log.restore();
  }
});

Deno.test("pb ls does not announce the project when --project names it", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  const log = captureErr();
  try {
    await makeResourceCommands(d, KINDS.pocketbases)["pocketbase ls"].run({}, {
      args: [],
      flags: flags({ json: false, project: p.id }),
    });
    assertEquals(log.lines.some((l) => l.startsWith("Project:")), false);
  } finally {
    log.restore();
  }
});

Deno.test("pb ls announces nothing under --json", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  const log = captureLog();
  try {
    await makeResourceCommands(d, KINDS.pocketbases)["pocketbase ls"].run({}, {
      args: [],
      flags: flags({ json: true }),
    });
    assertEquals(log.lines.some((l) => l.startsWith("Project:")), false);
  } finally {
    log.restore();
  }
});
