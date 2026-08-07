import { assertEquals, assertRejects } from "@std/assert";
import { makePbCommands, pushHooks } from "../../../src/commands/pb.ts";
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

Deno.test("pb deploy creates on the owner's Pro compute, which is never auto-selected", async () => {
  // The platform's auto-selection only considers the shared platform pool, so
  // a Pro instance created without a compute lands on shared infrastructure.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  withComputes(client, [{ id: "srv9", name: "pro-1", location: "GRA" }]);
  const code = await makePbCommands(d)["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
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
  const code = await makePbCommands(d)["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
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
      makePbCommands(d)["cloud pb deploy"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { name: "db1" },
      }),
    Error,
    "--compute",
  );
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb deploy forwards --compute, and the old --server still works", async () => {
  for (
    const raw of [{ name: "db1", compute: "srv1" }, {
      name: "db1",
      server: "srv1",
    }]
  ) {
    const client = createMockCloudClient();
    const p = await client.createProject("app");
    const { d, config } = deps(client);
    config.currentProject = p.id;
    runningNow(client);
    client.deployContext = () => {
      throw new Error("a named compute must not be second-guessed");
    };
    const code = await makePbCommands(d)["cloud pb deploy"]({
      args: [],
      flags: flags({ project: p.id }),
      raw: { ...raw, project: p.id },
    });
    assertEquals(code, 0);
    assertEquals(client.calls.createResource[0][1].server, "srv1");
  }
});

Deno.test("pb redeploy never re-picks the compute", async () => {
  // Moving a running instance to another host would change its URL and leave
  // its data behind — so the context is not even consulted.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db1", project: p.id });
  client.calls.createResource.length = 0; // seeding is not the deploy's doing
  const { d, config } = deps(client);
  config.currentProject = p.id;
  runningNow(client);
  client.deployContext = () => {
    throw new Error("deploy-context must not be called on a redeploy");
  };
  const code = await makePbCommands(d)["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 0);
});

// --- Hook uploads -----------------------------------------------------------
//
// A hook routinely `require()`s a plain .js helper or a .json data file beside
// it. The filter used to be `*.pb.js` only, so those were dropped in silence
// and the instance failed at runtime with a `require` error that nothing in
// the deploy output explained.

/** A pb_hooks directory holding exactly `files`. */
function hooksDir(files: Record<string, string>): string {
  const dir = Deno.makeTempDirSync();
  for (const [name, content] of Object.entries(files)) {
    Deno.writeTextFileSync(`${dir}/${name}`, content);
  }
  return dir;
}

/** Filenames sent to the bulk-write route, in call order. */
function pushedNames(
  client: ReturnType<typeof createMockCloudClient>,
): string[] {
  const call = client.calls.pbApi.find(([p]) => p === "/api/hooks/bulk-write");
  if (!call) return [];
  const body = call[1] as { hooks: { filename: string }[] };
  return body.hooks.map((h) => h.filename).sort();
}

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
  // An omitted `active` is recorded verbatim as false, which shows a live hook
  // as disabled in the portal.
  const client = createMockCloudClient();
  const dir = hooksDir({ "helpers.js": "x\n" });
  await pushHooks(client, "pb1", dir);
  const body = client.calls.pbApi[0][1] as {
    hooks: { active: boolean }[];
  };
  assertEquals(body.hooks.every((h) => h.active === true), true);
});

Deno.test("pushHooks skips subdirectories and says so", async () => {
  // The agent's validateHookFilename() rejects a name holding a path
  // separator, so nothing under a subdirectory can reach the instance.
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

Deno.test("pushHooks refuses more than 10 files in one push", async () => {
  const client = createMockCloudClient();
  const files: Record<string, string> = {};
  for (let i = 0; i < 11; i++) files[`h${i}.js`] = "// hook\n";
  await assertRejects(
    () => pushHooks(client, "pb1", hooksDir(files)),
    Error,
    "pushes at most 10 at a time",
  );
  // Nothing was uploaded: a partial push would leave the instance half-updated.
  assertEquals(client.calls.pbApi.length, 0);
});

Deno.test("pushHooks accepts a directory sitting exactly on the limit", async () => {
  // Off-by-one guard: 10 is allowed, 11 is not.
  const client = createMockCloudClient();
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`h${i}.js`] = "// hook\n";
  const r = await pushHooks(client, "pb1", hooksDir(files));
  assertEquals(r.sent, 10);
  assertEquals(client.calls.pbApi.length, 1);
});

Deno.test("pushHooks reports what the platform stored, not what it sent", async () => {
  // A 200 only means the batch was accepted — details.results[] still carries
  // per-file failures, and counting the files we sent hides them.
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

Deno.test("pb redeploy pushes the hook directory's .js helpers", async () => {
  // The end-to-end shape of the bug: main.pb.js reached the instance on a
  // redeploy while the helper it requires stayed behind.
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
    `${cwd}/pb.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: pb.id, name: "db1" } },
    }),
  );
  const code = await makePbCommands(d)["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(pushedNames(client), ["helpers.js", "main.pb.js", "seed.json"]);
});
