import { assertEquals, assertRejects } from "@std/assert";
import { makePbCommands, pushHooks } from "../../../src/commands/pb.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
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
      envStatePath: tempStatePath(),
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

/** Canned answers for the one question `create` asks. */
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
  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 1);
  // `user` is required by the collection and is what the slot check reads.
  assertEquals(client.calls.createResource[0][1].user, "u1");
  // Deploy recorded the new resource in the directory's pbc.json, under the
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
    `${cwd}/pbc.json`,
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
    `${cwd}/pbc.json`,
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
    `${cwd}/pbc.json`,
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
    `${cwd}/pbc.json`,
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
    raw: { name: "db1" }, // no --pb-version, and the cwd has no pbc.json pin
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

// --- pb create -------------------------------------------------------------
//
// `create` is the sibling of `pbc cloud project create`, not a second deploy:
// it provisions an instance and touches no file in the working directory.

Deno.test("pb create makes a running instance and sends no archive", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const code = await makePbCommands(d)["cloud pb create"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 1);
  const [kind, data] = client.calls.createResource[0];
  assertEquals(kind, "pocketbases");
  assertEquals(data.name, "db1");
  assertEquals(data.project, p.id);
  // Required by the collection, and what the slot check reads.
  assertEquals(data.user, "u1");
  assertEquals(data.status, "creating");
  // Nothing is packaged, so nothing is attached — an entry-less archive is
  // refused by the platform's unzip.
  assertEquals(data.zipFile, undefined);
  assertEquals(data.zipFileSize, undefined);
  // The platform never invents these; a blank one fails the deploy outright.
  assertEquals(data.adminUsername, "u@e.com");
  assertEquals(typeof data.adminPassword, "string");
  assertEquals((data.adminPassword as string).length, 20);
  // Never blank: an empty version strands the instance in `creating` with no
  // error status ever written.
  assertEquals(typeof data.version, "string");
  assertEquals((data.version as string).length > 0, true);
});

Deno.test("pb create records the instance in pbc.json", async () => {
  // So the next `pbc cloud pb deploy` in this directory needs no --name — the
  // same binding a deploy would have written, minus the build block, which
  // nothing was packaged from.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  runningNow(client);
  await makePbCommands(d)["cloud pb create"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
  });
  const link = await readLinkFile(cwd);
  assertEquals(link?.projectId, p.id);
  assertEquals(link?.kind, "pocketbases");
  assertEquals(link?.defaultEnvironment, "production");
  assertEquals(link?.environments, {
    production: {
      id: (await client.listResources("pocketbases", p.id))[0].id,
      name: "db1",
    },
  });
  // No envFile: nothing was pushed, so the first deploy here still gets to ask
  // which dotenv file this environment uses.
  assertEquals(
    "envFile" in (link?.environments?.production ?? {}),
    false,
  );
  // Nothing was packaged, so there is no build block to record either.
  assertEquals(link?.build, undefined);
});

Deno.test("pb create records under --env, leaving the default alone", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  runningNow(client);
  // A directory that already deploys production: a second environment is
  // added beside it, and production keeps its binding.
  await Deno.writeTextFile(
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: "existing", name: "db-prod" } },
    }),
  );
  const code = await makePbCommands(d)["cloud pb create"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db-staging", env: "staging" },
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
  // Overwriting it would silently orphan the binding to a live instance —
  // the directory would stop being able to reach it at all.
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
      makePbCommands(d)["cloud pb create"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { name: "db2" },
      }),
    CliError,
    "already binds",
  );
  assertEquals(err.exitCode, 2);
  assertEquals(err.message.includes("--env"), true);
  // Refused before anything was provisioned, so there is nothing to clean up.
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb create refuses a directory bound to another kind", async () => {
  // `kind` is shared by every environment in a pbc.json, so a frontend
  // directory cannot also bind a PocketBase.
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
      makePbCommands(d)["cloud pb create"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { name: "db1" },
      }),
    CliError,
    "bound to frontends",
  );
  assertEquals(err.exitCode, 2);
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb create records the binding even when provisioning fails", async () => {
  // The record exists either way, and the binding is how `info`, `logs` and
  // `rm` reach it. Losing it would leave an instance nothing can name.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "error",
  });
  const code = await makePbCommands(d)["cloud pb create"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
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
  const code = await makePbCommands(d)["cloud pb create"]({
    args: ["db2"],
    flags: flags({ project: p.id }),
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].name, "db2");
});

Deno.test("pb create refuses a name the project already uses, naming deploy", async () => {
  // The one thing that separates create from deploy. Creating a second
  // instance under the same name would also make every later --name lookup
  // ambiguous.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  client.calls.createResource.length = 0; // seeding is not the command's doing
  const { d } = deps(client);
  runningNow(client);
  const err = await assertRejects(
    () =>
      makePbCommands(d)["cloud pb create"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { name: "db1" },
      }),
    CliError,
    "already exists",
  );
  assertEquals(err.exitCode, 2);
  // The way out has to be in the message, or the refusal is just a wall.
  assertEquals(err.message.includes("pbc cloud pb deploy --name db1"), true);
  assertEquals(err.message.includes(pb.id), true);
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb create with no name and no terminal says how to pass one", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  const err = await assertRejects(
    () =>
      makePbCommands(d)["cloud pb create"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: {},
      }),
    CliError,
    "pbc cloud pb create <name>",
  );
  assertEquals(err.exitCode, 2);
  assertEquals(client.calls.createResource.length, 0);
});

Deno.test("pb create asks for a name on a terminal, defaulting to the directory", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, cwd } = deps(client);
  runningNow(client);
  // Two questions, both answered with a bare return: the name, then which
  // environment to record it under — the same one `deploy` and `link` ask in a
  // directory that names none yet. Empty means "take the suggestion".
  d.io = fakeIO(["", ""]);
  const code = await makePbCommands(d)["cloud pb create"]({
    args: [],
    flags: flags({ project: p.id, json: false, noInput: false }),
    raw: {},
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
  const code = await makePbCommands(d)["cloud pb create"]({
    args: ["db1"],
    flags: flags({ project: p.id, json: false, noInput: false }),
    raw: {},
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
  const code = await makePbCommands(d)["cloud pb create"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: {
      name: "db1",
      "admin-email": "ops@example.com",
      "admin-password": "correcthorsebattery",
    },
  });
  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.adminUsername, "ops@example.com");
  assertEquals(data.adminPassword, "correcthorsebattery");
});

Deno.test("pb create rejects an unusable --admin-password", async () => {
  // The field is 12-20 characters wherever the platform validates it, so a
  // password that cannot be used is caught before anything is provisioned.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  await assertRejects(
    () =>
      makePbCommands(d)["cloud pb create"]({
        args: [],
        flags: flags({ project: p.id }),
        raw: { name: "db2", "admin-password": "short" },
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
  const code = await makePbCommands(d)["cloud pb create"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1", "pb-version": "0.30.1" },
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
  const code = await makePbCommands(d)["cloud pb create"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1", location: "GRA", compute: "srv1" },
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
  const code = await makePbCommands(d)["cloud pb create"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: { name: "db1" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][1].server, "srv9");
});

Deno.test("pb create prints the generated login once, and where it was recorded", async () => {
  // The superuser account exists only on the new instance and the platform
  // never rotates it, so a generated password that is not printed is lost.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const log = captureLog();
  try {
    const code = await makePbCommands(d)["cloud pb create"]({
      args: [],
      flags: flags({ project: p.id, json: false }),
      raw: { name: "db1" },
    });
    assertEquals(code, 0);
  } finally {
    log.restore();
  }
  const password = client.calls.createResource[0][1].adminPassword as string;
  assertEquals(
    log.lines.some((l) => l.includes(`u@e.com / ${password}`)),
    true,
  );
  // And that the directory now points at it, which is what makes the next
  // deploy a bare `pbc cloud pb deploy`.
  assertEquals(
    log.lines.some((l) =>
      l.includes('Recorded in pbc.json as environment "production"')
    ),
    true,
  );
});

Deno.test("pb create --json prints the instance with its credentials", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  runningNow(client);
  const log = captureLog();
  try {
    await makePbCommands(d)["cloud pb create"]({
      args: [],
      flags: flags({ project: p.id }),
      raw: { name: "db1" },
    });
  } finally {
    log.restore();
  }
  const out = JSON.parse(log.lines.at(-1) as string);
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

Deno.test("pushHooks refuses more than 30 files in one push", async () => {
  const client = createMockCloudClient();
  const files: Record<string, string> = {};
  for (let i = 0; i < 31; i++) files[`h${i}.js`] = "// hook\n";
  await assertRejects(
    () => pushHooks(client, "pb1", hooksDir(files)),
    Error,
    "pushes at most 30 at a time",
  );
  // Nothing was uploaded: a partial push would leave the instance half-updated.
  assertEquals(client.calls.pbApi.length, 0);
});

Deno.test("pushHooks accepts a directory sitting exactly on the limit", async () => {
  // Off-by-one guard: 30 is allowed, 31 is not.
  const client = createMockCloudClient();
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`h${i}.js`] = "// hook\n";
  const r = await pushHooks(client, "pb1", hooksDir(files));
  assertEquals(r.sent, 30);
  assertEquals(client.calls.pbApi.length, 1);
});

Deno.test("pushHooks refuses a file longer than the content limit", async () => {
  // A push sends active: true, so the agent — which accepts up to 1MB — writes
  // the file to the running instance before the database refuses to store it.
  // Catching it here is what keeps the instance and the portal editor in
  // agreement.
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
  // The whole batch is refused: a partial push leaves the instance running
  // some files from this version and some from the last.
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
  // The route answers a failure with { error, details }, and `details` carries
  // the sentence worth reading. Reporting only the status code — which is what
  // this did — leaves the user with a bare number.
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

Deno.test("pb redeploy ships the hook directory's .js helpers in the archive", async () => {
  // The end-to-end shape of the bug: main.pb.js reached the instance on a
  // redeploy while the helper it requires stayed behind. The route changed —
  // hooks now travel in the archive and the platform installs them — but the
  // guarantee has not: every file in pb_hooks must arrive.
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
  const code = await makePbCommands(d)["cloud pb deploy"]({
    args: [],
    flags: flags({ project: p.id }),
    raw: {},
  });
  assertEquals(code, 0);
  const [, , data] = client.calls.updateResource[0];
  const zip = new Uint8Array(await (data.zipFile as File).arrayBuffer());
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
  // Pushing separately as well would write every file twice and restart the
  // instance twice — the platform installs them from the archive.
  assertEquals(pushedNames(client), []);
});

function captureLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.log = original };
}

Deno.test("pb ls announces the project resolved from config.currentProject", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  const log = captureLog();
  try {
    const code = await makePbCommands(d)["cloud pb ls"]({
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

Deno.test("pb ls does not announce the project when --project names it", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d } = deps(client);
  const log = captureLog();
  try {
    await makePbCommands(d)["cloud pb ls"]({
      args: [],
      flags: flags({ json: false, project: p.id }),
      raw: {},
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
    await makePbCommands(d)["cloud pb ls"]({
      args: [],
      flags: flags({ json: true }),
      raw: {},
    });
    assertEquals(log.lines.some((l) => l.startsWith("Project:")), false);
  } finally {
    log.restore();
  }
});
