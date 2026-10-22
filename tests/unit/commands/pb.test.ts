import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { HashIndex } from "../../../src/hash-index.ts";
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
): {
  d: CloudCmdDeps & { deploy: MockDeployFetch };
  config: Config;
  cwd: string;
} {
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

Deno.test("pb deploy shows why the instance did not finish setting up", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "error",
    statusMessage: "No free-tier capacity available",
  });
  d.deploy.setStatus(
    "failed",
    "This instance did not finish setting up. Contact support.",
  );
  const cmds = makePbCommands(d);
  await assertRejects(
    () =>
      cmds["pocketbase deploy"].run({ new: "db1" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    CliError,
    "No free-tier capacity available",
  );
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
  const code = await makeResourceCommands(d, KINDS.pocketbases)["pocketbase rm"]
    .run({}, {
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
  const code = await makePbCommands(d)["pocketbase deploy"].run(
    { new: "db1" },
    {
      args: [],
      flags: flags({ project: p.id }),
    },
  );
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
  const code = await makePbCommands(d)["pocketbase deploy"].run(
    { new: "db1" },
    {
      args: [],
      flags: flags({ project: p.id }),
    },
  );
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
  const code = await makePbCommands(d)["pocketbase deploy"].run(
    { new: "db1" },
    {
      args: [],
      flags: flags({ project: p.id }),
    },
  );
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
  const code = await makePbCommands(d)["pocketbase deploy"].run(
    { name: "db1" },
    {
      args: [],
      flags: flags({ project: p.id }),
    },
  );
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 0);
});

function hooksDir(files: Record<string, string>): string {
  const dir = Deno.makeTempDirSync();
  for (const [name, content] of Object.entries(files)) {
    const slash = name.lastIndexOf("/");
    if (slash >= 0) {
      Deno.mkdirSync(`${dir}/${name.slice(0, slash)}`, { recursive: true });
    }
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

Deno.test("pb continuous-backup status maps the instance state", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const resource = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  client.ext = (path, body) => {
    client.calls.ext.push([path, body]);
    return Promise.resolve(
      Response.json({
        success: true,
        data: { enabled: true, running: false, restorable: true },
      }),
    );
  };
  const { d } = deps(client);
  const log = captureLog();
  try {
    const code = await makePbCommands(d)["pocketbase continuous-backup status"]
      .run({ name: "db1" }, {
        args: [],
        flags: flags({ project: p.id }),
      });
    assertEquals(code, 0);
  } finally {
    log.restore();
  }
  assertEquals(client.calls.ext.at(-1), [
    "/api/pocketbases/continuous-backup/status",
    { pocketbaseId: resource.id },
  ]);
  assertEquals(JSON.parse(log.lines.at(-1)!).data, {
    enabled: true,
    running: false,
    restorable: true,
  });
});

Deno.test("pb continuous-backup enable posts the instance id", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const resource = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const { d } = deps(client);
  await makePbCommands(d)["pocketbase continuous-backup enable"].run({
    name: "db1",
  }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(client.calls.ext.at(-1), [
    "/api/pocketbases/continuous-backup/enable",
    { pocketbaseId: resource.id },
  ]);
});

Deno.test("pb continuous-backup disable posts the instance id", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const resource = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const { d } = deps(client);
  await makePbCommands(d)["pocketbase continuous-backup disable"].run({
    name: "db1",
  }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(client.calls.ext.at(-1), [
    "/api/pocketbases/continuous-backup/disable",
    { pocketbaseId: resource.id },
  ]);
});

Deno.test("pb continuous-backup enable surfaces a plan refusal", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db1", project: p.id });
  client.ext = () =>
    Promise.resolve(
      Response.json(
        { success: false, error: "Continuous backup requires a paid plan" },
        { status: 400 },
      ),
    );
  const { d } = deps(client);
  await assertRejects(
    () =>
      makePbCommands(d)["pocketbase continuous-backup enable"].run({
        name: "db1",
      }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    CliError,
    "paid plan",
  );
});

const MANAGED_EMAIL_STATE = {
  enabled: true,
  status: "active",
  statusReason: "",
  trust: "new",
  senderAddress: "i-pb1@mail.example.net",
  relayHost: "smtp.mail.example.net",
  planEligible: true,
  limits: {
    daily: 100,
    monthly: 1000,
    perMinute: 10,
    maxRecipients: 1,
    maxBytes: 1048576,
    queueDepth: 50,
  },
  usage: { today: 3, month: 40 },
};

async function managedEmailClient(data: unknown) {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const resource = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  client.ext = (path, body) => {
    client.calls.ext.push([path, body]);
    return Promise.resolve(Response.json({ success: true, data }));
  };
  return { client, projectId: p.id, resourceId: resource.id };
}

async function runCommand(
  client: ReturnType<typeof createMockCloudClient>,
  projectId: string,
  key: string,
  json = true,
) {
  const { d } = deps(client);
  const log = captureLog();
  try {
    const code = await makePbCommands(d)[key].run({ name: "db1" }, {
      args: [],
      flags: flags({ project: projectId, json }),
    });
    assertEquals(code, 0);
  } finally {
    log.restore();
  }
  return log.lines;
}

Deno.test("pb email status returns the platform state", async () => {
  const { client, projectId, resourceId } = await managedEmailClient(
    MANAGED_EMAIL_STATE,
  );
  const lines = await runCommand(client, projectId, "pocketbase email status");
  assertEquals(client.calls.ext.at(-1), [
    "/api/pocketbases/email/status",
    { pocketbaseId: resourceId },
  ]);
  assertEquals(JSON.parse(lines.at(-1)!).data, MANAGED_EMAIL_STATE);
});

Deno.test("pb email status prints usage against the limits", async () => {
  const { client, projectId } = await managedEmailClient({
    ...MANAGED_EMAIL_STATE,
    status: "paused_reputation",
    statusReason: "bounce_rate",
  });
  const lines = await runCommand(
    client,
    projectId,
    "pocketbase email status",
    false,
  );
  const text = lines.join("\n");
  assertStringIncludes(text, "Status: paused_reputation (bounce_rate)");
  assertStringIncludes(text, "Sender level: new");
  assertStringIncludes(text, "Sender address: i-pb1@mail.example.net");
  assertStringIncludes(text, "Sent today: 3 / 100");
  assertStringIncludes(text, "Sent this month: 40 / 1000");
});

for (
  const [action, path] of [
    ["enable", "/api/pocketbases/email/enable"],
    ["disable", "/api/pocketbases/email/disable"],
    ["reapply", "/api/pocketbases/email/reapply"],
  ] as const
) {
  Deno.test(`pb email ${action} posts the instance id`, async () => {
    const { client, projectId, resourceId } = await managedEmailClient(
      MANAGED_EMAIL_STATE,
    );
    const lines = await runCommand(
      client,
      projectId,
      `pocketbase email ${action}`,
    );
    assertEquals(client.calls.ext.at(-1), [path, { pocketbaseId: resourceId }]);
    assertEquals(JSON.parse(lines.at(-1)!).data, MANAGED_EMAIL_STATE);
  });
}

Deno.test("pb email messages lists recent emails", async () => {
  const messages = [{
    id: "m1",
    recipient: "ada@example.org",
    status: "delivered",
    reason: "",
    subject: "Verify your email",
    created: "2026-10-19 10:00:00.000Z",
  }];
  const { client, projectId, resourceId } = await managedEmailClient(messages);
  const lines = await runCommand(
    client,
    projectId,
    "pocketbase email messages",
  );
  assertEquals(client.calls.ext.at(-1), [
    "/api/pocketbases/email/messages",
    { pocketbaseId: resourceId },
  ]);
  assertEquals(JSON.parse(lines.at(-1)!).data, messages);

  const text = (await runCommand(
    client,
    projectId,
    "pocketbase email messages",
    false,
  )).join("\n");
  assertStringIncludes(text, "ada@example.org");
  assertStringIncludes(text, "delivered");
});

Deno.test("pb email test sends to the given address or the signed-in user", async () => {
  const { client, projectId, resourceId } = await managedEmailClient({
    to: "qa@acme.io",
  });
  const { d } = deps(client);
  const log = captureLog();
  try {
    await makePbCommands(d)["pocketbase email test"].run({
      name: "db1",
      to: "qa@acme.io",
    }, { args: [], flags: flags({ project: projectId, json: false }) });
  } finally {
    log.restore();
  }
  assertEquals(client.calls.ext.at(-1), [
    "/api/pocketbases/email/test",
    { pocketbaseId: resourceId, to: "qa@acme.io" },
  ]);
  assertStringIncludes(log.lines.join("\n"), "Test email sent to qa@acme.io");
  await runCommand(client, projectId, "pocketbase email test");
  assertEquals(client.calls.ext.at(-1), [
    "/api/pocketbases/email/test",
    { pocketbaseId: resourceId },
  ]);
});

Deno.test("pb email sender prints the sender and warns when replies are lost", async () => {
  const identity = {
    senderName: "Support",
    senderAddress: "noreply@example.com",
    replyReachable: false,
    otherSmtpHost: "",
  };
  const { client, projectId, resourceId } = await managedEmailClient(identity);
  const lines = await runCommand(
    client,
    projectId,
    "pocketbase email sender",
    false,
  );
  assertEquals(client.calls.ext.at(-1), [
    "/api/pocketbases/email/identity",
    { pocketbaseId: resourceId },
  ]);
  const text = lines.join("\n");
  assertStringIncludes(text, "Sender name: Support");
  assertStringIncludes(text, "Reply-to: noreply@example.com");
  assertStringIncludes(text, "Replies are not delivered");
});

Deno.test("pb email sender updates the name and reply-to address", async () => {
  const { client, projectId, resourceId } = await managedEmailClient({
    senderName: "Acme",
    senderAddress: "hi@acme.io",
    replyReachable: true,
    otherSmtpHost: "",
  });
  const { d } = deps(client);
  const log = captureLog();
  try {
    await makePbCommands(d)["pocketbase email sender"].run({
      name: "db1",
      senderName: "Acme",
      replyTo: "hi@acme.io",
    }, { args: [], flags: flags({ project: projectId }) });
  } finally {
    log.restore();
  }
  assertEquals(client.calls.ext.at(-1), [
    "/api/pocketbases/email/identity/update",
    {
      pocketbaseId: resourceId,
      senderName: "Acme",
      senderAddress: "hi@acme.io",
    },
  ]);
});

Deno.test("pb email sender asks for both values when updating", async () => {
  const { client, projectId } = await managedEmailClient({});
  const { d } = deps(client);
  await assertRejects(
    () =>
      makePbCommands(d)["pocketbase email sender"].run({
        name: "db1",
        replyTo: "hi@acme.io",
      }, { args: [], flags: flags({ project: projectId }) }),
    CliError,
    "--sender-name",
  );
});

Deno.test("pb email enable surfaces the platform refusal", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db1", project: p.id });
  client.ext = () =>
    Promise.resolve(
      Response.json(
        { success: false, error: "Managed email needs a Starter or Pro plan" },
        { status: 403 },
      ),
    );
  const { d } = deps(client);
  await assertRejects(
    () =>
      makePbCommands(d)["pocketbase email enable"].run({ name: "db1" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    CliError,
    "Starter or Pro",
  );
});

Deno.test("pb create keeps backup restore available as a create flag", () => {
  const command = makePbCommands(deps().d)["pocketbase create"];
  assertEquals(command.summary, "Create a PocketBase instance.");
  assertEquals(command.usage, "pbc pocketbase create [<name>] [flags]");
  assertEquals(
    command.flags.backup.description,
    "PocketBase backup ZIP to restore during creation.",
  );
  assertEquals(command.flags.backup.conflicts, ["adminEmail", "adminPassword"]);
});

Deno.test("pb create makes a running instance and sends no archive", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const code = await makePbCommands(d)["pocketbase create"].run(
    { name: "db1" },
    {
      args: [],
      flags: flags({ project: p.id }),
    },
  );
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
  const err = await assertRejects(
    () =>
      makePbCommands(d)["pocketbase create"].run({ name: "db1" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    CliError,
  );
  assertEquals(err.exitCode, 7);
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
  const code = await makePbCommands(d)["pocketbase create"].run(
    { name: "db1" },
    {
      args: [],
      flags: flags({ project: p.id }),
    },
  );
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
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 200 }));
  const originalExt = client.ext;
  client.ext = (path, body) => {
    if (path === "/api/pocketbases/backup-upload-url") {
      client.calls.ext.push([path, body]);
      return Promise.resolve(
        Response.json({
          data: { key: "backup-key", uploadUrl: "https://upload", maxMB: 150 },
        }),
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
      line.includes(
        "Admin login: preserved from backup; credentials are not available",
      )
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

Deno.test("pushHooks uploads .js, .json, .html, and .md, not just *.pb.js", async () => {
  const client = createMockCloudClient();
  const dir = hooksDir({
    "main.pb.js": "// entrypoint\n",
    "helpers.js": "module.exports = {}\n",
    "countries.json": "[]\n",
    "README.md": "docs, not code\n",
    "template.html": "<p>hi</p>\n",
    "logo.png": "not a supported hook type\n",
  });
  const r = await pushHooks(client, "pb1", dir);
  assertEquals(r, { sent: 5, stored: 5 });
  assertEquals(pushedNames(client), [
    "README.md",
    "countries.json",
    "helpers.js",
    "main.pb.js",
    "template.html",
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

Deno.test("pushHooks uploads nested files with their relative path", async () => {
  const client = createMockCloudClient();
  const dir = hooksDir({ "main.pb.js": "// hook\n" });
  Deno.mkdirSync(`${dir}/lib`);
  Deno.writeTextFileSync(`${dir}/lib/deep.js`, "// nested\n");
  const r = await pushHooks(client, "pb1", dir);
  assertEquals(r.sent, 2);
  assertEquals(pushedNames(client), ["lib/deep.js", "main.pb.js"]);
});

Deno.test("pushHooks skips a file nested too deep and still pushes the rest", async () => {
  const client = createMockCloudClient();
  const dir = hooksDir({
    "main.pb.js": "// hook\n",
    "a/b/c/d/e/f/g.js": "// too deep\n",
  });
  const logs: string[] = [];
  const r = await pushHooks(client, "pb1", dir, (m) => logs.push(m));
  assertEquals(r.sent, 1);
  assertEquals(pushedNames(client), ["main.pb.js"]);
  assertEquals(logs.length, 1);
  assertEquals(logs[0].includes("a/b/c/d/e/f/g.js"), true);
  assertEquals(logs[0].includes("nested more than"), true);
});

Deno.test("pushHooks refuses more than 500 files in one push", async () => {
  const client = createMockCloudClient();
  const files: Record<string, string> = {};
  for (let i = 0; i < 501; i++) files[`h${i}.js`] = "// hook\n";
  await assertRejects(
    () => pushHooks(client, "pb1", hooksDir(files)),
    Error,
    "pushes at most 500 at a time",
  );
  assertEquals(client.calls.pbApi.length, 0);
});

Deno.test("pushHooks accepts a directory sitting exactly on the limit", async () => {
  const client = createMockCloudClient();
  const files: Record<string, string> = {};
  for (let i = 0; i < 500; i++) files[`h${i}.js`] = "// hook\n";
  const r = await pushHooks(client, "pb1", hooksDir(files));
  assertEquals(r.sent, 500);
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
    const code = await makeResourceCommands(
      d,
      KINDS.pocketbases,
    )["pocketbase ls"].run({}, {
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

Deno.test("pb ls JSON omits admin credentials", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  Object.assign(pb, {
    adminUsername: "admin@example.com",
    adminPassword: "secret-password",
  });
  const { d, config } = deps(client);
  config.currentProject = p.id;
  const log = captureLog();

  try {
    await makeResourceCommands(d, KINDS.pocketbases)["pocketbase ls"].run({}, {
      args: [],
      flags: flags({ json: true }),
    });
  } finally {
    log.restore();
  }

  const resource = JSON.parse(log.lines[0]).data[0];
  assertEquals(resource.id, pb.id);
  assertEquals("adminUsername" in resource, false);
  assertEquals("adminPassword" in resource, false);
});

Deno.test("pb deploy sends the directory's revision, and --force leaves it out", async () => {
  for (const force of [false, true]) {
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
        environments: { production: { id: pb.id, name: "db1", revision: 7 } },
      }),
    );
    await makePbCommands(d)["pocketbase deploy"].run(force ? { force } : {}, {
      args: [],
      flags: flags({ project: p.id }),
    });
    const created = d.deploy.calls.find((c) =>
      c.url.endsWith("/api/deployments")
    );
    assertEquals(
      JSON.parse(created!.bodyText!).baseRevision,
      force ? undefined : 7,
    );
  }
});

async function boundInstance(
  revisions: Record<string, (body: Record<string, unknown>) => Response>,
) {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const { d, config, cwd } = deps(client);
  d.hashIndex = () => Promise.resolve(HashIndex.memory());
  config.currentProject = p.id;
  runningNow(client);
  await Deno.mkdir(`${cwd}/pb_hooks`, { recursive: true });
  await Deno.writeTextFile(`${cwd}/pb_hooks/main.pb.js`, "routerAdd()");
  await Deno.writeTextFile(
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1", revision: 7 } },
    }),
  );
  const posted: [string, Record<string, unknown>][] = [];
  const platformExt = client.ext;
  client.ext = (path, body) => {
    const action = path.startsWith("/api/pocketbases/revisions/")
      ? path.split("/").pop()!
      : "";
    const answer = revisions[action];
    if (!answer) return platformExt(path, body);
    posted.push([action, body as Record<string, unknown>]);
    return Promise.resolve(answer(body as Record<string, unknown>));
  };
  return { client, d, p, cwd, posted };
}

Deno.test("pb redeploy uploads only new files and commits them from the directory's revision", async () => {
  const { d, p, cwd, posted } = await boundInstance({
    upload: (body) =>
      Response.json({
        success: true,
        data: {
          uploads: (body.files as { hash: string }[]).map((f) => ({
            hash: f.hash,
            url: "https://r2/put",
          })),
        },
      }),
    commit: () => Response.json({ success: true, data: { revision: 8 } }),
    list: () =>
      Response.json({ success: true, data: { items: [{ number: 8 }] } }),
  });

  await makePbCommands(d)["pocketbase deploy"].run({}, {
    args: [],
    flags: flags({ project: p.id }),
  });

  const commit = posted.find(([action]) => action === "commit")![1];
  assertEquals(commit.baseRevision, 7);
  assertEquals((commit.files as { path: string }[]).map((f) => f.path), [
    "pb_hooks/main.pb.js",
  ]);
  assertEquals(
    d.deploy.calls.some((c) => c.url.endsWith("/api/deployments")),
    false,
  );
  assertEquals(
    d.deploy.calls.filter((c) => c.url === "https://r2/put").length,
    1,
  );
  const link = JSON.parse(await Deno.readTextFile(`${cwd}/pbc.json`));
  assertEquals(link.environments.production.revision, 8);
});

Deno.test("pb deploy --dry-run compares with the instance and changes nothing", async () => {
  const { d, p, client, posted } = await boundInstance({
    upload: () => Response.json({ success: true, data: { uploads: [] } }),
  });

  assertEquals(
    await makePbCommands(d)["pocketbase deploy"].run({ dryRun: true }, {
      args: [],
      flags: flags({ project: p.id }),
    }),
    0,
  );

  assertEquals(posted.map(([action]) => action), ["upload"]);
  assertEquals(d.deploy.calls, []);
  assertEquals(client.calls.updateResource, []);
});
