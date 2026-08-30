import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertArchiveWithinLimit,
  awaitDeployment,
  awaitReachable,
  chooseCompute,
  computeChooser,
  deployResource,
  findExisting,
  MAX_ARCHIVE_BYTES,
  pollStatus,
  reportUrl,
  resolveDeployIntent,
  resolveEnvironmentTarget,
  resolveOwnerId,
  suggestName,
  validateLocationChoice,
} from "../../../src/commands/deploy-helper.ts";
import type {
  DeployIntent,
  Target,
} from "../../../src/commands/deploy-helper.ts";
import { KINDS } from "../../../src/kinds.ts";
import { CliError } from "../../../src/errors.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import type { Resource } from "../../../src/clients/types.ts";
import type { PromptIO } from "../../../src/ui/prompt.ts";
import { plainProgress } from "../../../src/ui/progress.ts";
import { join } from "@std/path";

function fakeIO(inputs: string[]): PromptIO {
  const q = [...inputs];
  return {
    read: () => Promise.resolve(q.shift() ?? null),
    write: () => {},
    isTTY: true,
  };
}

const R = (id: string, name: string): Resource => ({
  id,
  name,
  status: "running",
  project: "p1",
  createdBy: "u1",
});

Deno.test("findExisting matches id then unique name", () => {
  const rs = [R("a", "one"), R("b", "two")];
  const byId = findExisting(rs, { id: "b" });
  assertEquals(byId !== "ambiguous" ? byId?.name : undefined, "two");
  const byName = findExisting(rs, { name: "one" });
  assertEquals(byName !== "ambiguous" ? byName?.id : undefined, "a");
  assertEquals(findExisting(rs, { name: "nope" }), null);
});

Deno.test("findExisting flags duplicate names", () => {
  assertEquals(
    findExisting([R("a", "dup"), R("b", "dup")], { name: "dup" }),
    "ambiguous",
  );
});

const ENV_BASE = { environment: "production", hasEnvironments: false };

Deno.test("deployResource creates for a create intent and injects the name", async () => {
  const c = createMockCloudClient();
  const intent: DeployIntent = { ...ENV_BASE, create: true, name: "db1" };
  const { created, resource } = await deployResource(
    c,
    "pocketbases",
    intent,
    { data: { project: "p1" } },
  );
  assertEquals(created, true);
  assertEquals(resource.name, "db1");
  assertEquals(c.calls.createResource[0][1].name, "db1");
});

Deno.test("deployResource updates the resolved resource for an update intent", async () => {
  const c = createMockCloudClient();
  const made = await c.createResource("pocketbases", {
    name: "db1",
    project: "p1",
  });
  const intent: DeployIntent = {
    ...ENV_BASE,
    create: false,
    resource: made,
    fromBinding: false,
  };
  const { created, resource } = await deployResource(
    c,
    "pocketbases",
    intent,
    { data: { note: "x" } },
  );
  assertEquals(created, false);
  assertEquals(resource.id, made.id);
});

async function withBinding(bound: boolean): Promise<string> {
  const dir = await Deno.makeTempDir();
  if (bound) {
    await Deno.writeTextFile(
      join(dir, "pbc.json"),
      JSON.stringify({
        projectId: "p1",
        kind: "frontends",
        defaultEnvironment: "production",
        environments: {
          production: { id: "fe1", name: "web" },
          staging: { id: "fe2", name: "web-staging" },
        },
      }),
    );
  }
  return dir;
}

Deno.test("resolveEnvironmentTarget: an explicit name wins over any binding", async () => {
  const dir = await withBinding(true);
  try {
    assertEquals(await resolveEnvironmentTarget({ name: "y" }, "frontends", dir), {
      name: "y",
      fromBinding: false,
      environment: "production",
      hasEnvironments: true,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveEnvironmentTarget: falls back to the default environment's entry", async () => {
  const dir = await withBinding(true);
  try {
    assertEquals(await resolveEnvironmentTarget({}, "frontends", dir), {
      id: "fe1",
      fromBinding: true,
      environment: "production",
      hasEnvironments: true,
    });
    assertEquals(await resolveEnvironmentTarget({}, "backends", dir), {
      fromBinding: false,
      environment: "production",
      hasEnvironments: true,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveEnvironmentTarget: --env picks that environment's entry", async () => {
  const dir = await withBinding(true);
  try {
    assertEquals(
      await resolveEnvironmentTarget({}, "frontends", dir, { envFlag: "staging" }),
      {
        id: "fe2",
        fromBinding: true,
        environment: "staging",
        hasEnvironments: true,
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveEnvironmentTarget: an unconfigured --env is an error", async () => {
  const dir = await withBinding(true);
  try {
    await assertRejects(
      () => resolveEnvironmentTarget({}, "frontends", dir, { envFlag: "preview" }),
      Error,
      'Unknown environment "preview". Configured: production, staging.',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveEnvironmentTarget: strictKind refuses a directory bound to another kind", async () => {
  const dir = await withBinding(true);
  try {
    await assertRejects(
      () => resolveEnvironmentTarget({}, "backends", dir, { strictKind: true }),
      Error,
      "pbc.json is bound to frontends — deploy backends from a different",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveEnvironmentTarget: no flags and no binding yields nothing", async () => {
  const dir = await withBinding(false);
  try {
    assertEquals(await resolveEnvironmentTarget({}, "frontends", dir), {
      fromBinding: false,
      environment: "production",
      hasEnvironments: false,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveEnvironmentTarget: a --name that differs from the bound env is CONFLICT on deploy", async () => {
  const dir = await withBinding(true);
  try {
    const err = await assertRejects(
      () =>
        resolveEnvironmentTarget({ name: "other" }, "frontends", dir, {
          allowNewEnvironment: true,
        }),
      CliError,
    );
    assertEquals(err.code, "CONFLICT");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveEnvironmentTarget: a --name matching the bound env is allowed on deploy", async () => {
  const dir = await withBinding(true);
  try {
    assertEquals(
      await resolveEnvironmentTarget({ name: "web" }, "frontends", dir, {
        allowNewEnvironment: true,
      }),
      {
        name: "web",
        fromBinding: false,
        environment: "production",
        hasEnvironments: true,
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const EMPTY: Target = {
  fromBinding: false,
  environment: "production",
  hasEnvironments: false,
};

Deno.test("suggestName slugifies the directory name", () => {
  assertEquals(suggestName("/tmp/My React App"), "my-react-app");
  assertEquals(suggestName("/tmp/___"), "app");
});

async function feClient(names: string[]) {
  const c = createMockCloudClient();
  const p = await c.createProject("app");
  for (const n of names) {
    await c.createResource("frontends", { name: n, project: p.id });
  }
  return { c, projectId: p.id };
}

function intentCtx(
  over: Partial<Parameters<typeof resolveDeployIntent>[1]> & {
    client: Parameters<typeof resolveDeployIntent>[1]["client"];
    projectId: string;
  },
) {
  return {
    spec: KINDS.frontends,
    cwd: "/tmp/app",
    noInput: false,
    io: fakeIO([]),
    ...over,
  };
}

Deno.test("resolveDeployIntent: --new on a free name is a create intent", async () => {
  const { c, projectId } = await feClient(["one"]);
  const intent = await resolveDeployIntent(
    EMPTY,
    intentCtx({ client: c, projectId, newName: "two" }),
  );
  assertEquals(intent.create, true);
  assertEquals(intent.create && intent.name, "two");
});

Deno.test("resolveDeployIntent: --new on a taken name is CONFLICT", async () => {
  const { c, projectId } = await feClient(["one"]);
  const err = await assertRejects(
    () =>
      resolveDeployIntent(
        EMPTY,
        intentCtx({ client: c, projectId, newName: "one" }),
      ),
    CliError,
  );
  assertEquals(err.code, "CONFLICT");
});

Deno.test("resolveDeployIntent: --new combined with a positional target is USAGE", async () => {
  const { c, projectId } = await feClient(["one"]);
  const err = await assertRejects(
    () =>
      resolveDeployIntent(
        { ...EMPTY, name: "one" },
        intentCtx({ client: c, projectId, newName: "two" }),
      ),
    CliError,
  );
  assertEquals(err.code, "USAGE");
});

Deno.test("resolveDeployIntent: --name that matches redeploys it", async () => {
  const { c, projectId } = await feClient(["one", "two"]);
  const intent = await resolveDeployIntent(
    { ...EMPTY, name: "two" },
    intentCtx({ client: c, projectId }),
  );
  assertEquals(intent.create, false);
  assertEquals(intent.create === false && intent.resource.name, "two");
});

Deno.test("resolveDeployIntent: --name that matches nothing is NOT_FOUND and creates nothing", async () => {
  const { c, projectId } = await feClient(["api-prod"]);
  const err = await assertRejects(
    () =>
      resolveDeployIntent(
        { ...EMPTY, name: "api-prd" },
        intentCtx({ client: c, projectId }),
      ),
    CliError,
  );
  assertEquals(err.code, "NOT_FOUND");
  assertStringIncludes(err.message, "api-prod");
  assertEquals(c.calls.createResource.length, 1);
});

Deno.test("resolveDeployIntent: a stale binding runs onStale then errors toward --new", async () => {
  const { c, projectId } = await feClient(["one"]);
  let cleaned = false;
  const err = await assertRejects(
    () =>
      resolveDeployIntent(
        { ...EMPTY, id: "gone", fromBinding: true },
        intentCtx({
          client: c,
          projectId,
          onStale: () => {
            cleaned = true;
            return Promise.resolve();
          },
        }),
      ),
    CliError,
  );
  assertEquals(err.code, "NOT_FOUND");
  assertStringIncludes(err.message, "--new");
  assertEquals(cleaned, true);
});

Deno.test("resolveDeployIntent: nothing named and non-interactive is NO_TARGET", async () => {
  const { c, projectId } = await feClient(["one"]);
  const err = await assertRejects(
    () =>
      resolveDeployIntent(
        EMPTY,
        intentCtx({ client: c, projectId, noInput: true }),
      ),
    CliError,
  );
  assertEquals(err.code, "NO_TARGET");
  assertStringIncludes(err.message, "--new");
});

Deno.test("resolveDeployIntent: the menu offers create above the list", async () => {
  const { c, projectId } = await feClient(["one"]);
  const intent = await resolveDeployIntent(
    EMPTY,
    intentCtx({ client: c, projectId, io: fakeIO(["1", "site"]) }),
  );
  assertEquals(intent.create, true);
  assertEquals(intent.create && intent.name, "site");
});

Deno.test("resolveDeployIntent: picking a list row redeploys it", async () => {
  const { c, projectId } = await feClient(["one", "two"]);
  const intent = await resolveDeployIntent(
    EMPTY,
    intentCtx({ client: c, projectId, io: fakeIO(["3"]) }),
  );
  assertEquals(intent.create === false && intent.resource.name, "two");
});

Deno.test("resolveDeployIntent: an empty account skips the menu and defaults the name", async () => {
  const { c, projectId } = await feClient([]);
  const intent = await resolveDeployIntent(
    EMPTY,
    intentCtx({
      client: c,
      projectId,
      cwd: "/tmp/My React App",
      io: fakeIO([""]),
    }),
  );
  assertEquals(intent.create && intent.name, "my-react-app");
});

Deno.test("resolveOwnerId prefers the stored id and falls back to whoami", async () => {
  const c = createMockCloudClient();
  assertEquals(await resolveOwnerId(c, { userId: "u9" }), "u9");
  assertEquals(await resolveOwnerId(c, { userId: "" }), "u1");
});

function clientWithComputes(
  computes: { id: string; name: string; location: string }[],
  context: {
    ownerPlan?: string;
    isOwner?: boolean;
    organization?: string;
  } = {},
) {
  const c = createMockCloudClient();
  c.deployContext = () =>
    Promise.resolve({
      ownerPlan: context.ownerPlan ?? "pro",
      isOwner: context.isOwner ?? true,
      organization: context.organization ?? "",
      servers: computes,
    });
  return c;
}

const CPU = (id: string, name: string) => ({ id, name, location: "GRA" });

Deno.test("chooseCompute takes the owner's only compute without asking", async () => {
  const said: string[] = [];
  const picked = await chooseCompute(
    clientWithComputes([CPU("s1", "pro-1")]),
    "p1",
    { noInput: false, log: (m) => said.push(m), io: fakeIO([]) },
  );
  assertEquals(picked, "s1");
  assertStringIncludes(said[0], "Compute 1 — Gravelines");
  assertStringIncludes(said[0], "s1");
});

Deno.test("chooseCompute offers an organization's compute off Pro", async () => {
  const picked = await chooseCompute(
    clientWithComputes([CPU("s1", "org-1")], {
      ownerPlan: "starter",
      organization: "org1",
    }),
    "p1",
    { noInput: true, log: () => {} },
  );
  assertEquals(picked, "s1");
});

Deno.test("chooseCompute leaves an org with no compute to the platform", async () => {
  const picked = await chooseCompute(
    clientWithComputes([], { ownerPlan: "free", organization: "org1" }),
    "p1",
    { noInput: true, log: () => {} },
  );
  assertEquals(picked, undefined);
});

Deno.test("chooseCompute asks which compute when the owner has several", async () => {
  const picked = await chooseCompute(
    clientWithComputes([CPU("s1", "pro-1"), CPU("s2", "pro-2")]),
    "p1",
    { noInput: false, log: () => {}, io: fakeIO(["1"]) },
  );
  assertEquals(picked, "s2");
});

Deno.test("chooseCompute names the ids instead of guessing under --no-input", async () => {
  await assertRejects(
    () =>
      chooseCompute(
        clientWithComputes([CPU("s1", "pro-1"), CPU("s2", "pro-2")]),
        "p1",
        { noInput: true, log: () => {} },
      ),
    CliError,
    "--compute",
  );
});

Deno.test("chooseCompute leaves the choice to the platform off Pro", async () => {
  const picked = await chooseCompute(
    clientWithComputes([CPU("s1", "shared-1")], { ownerPlan: "free" }),
    "p1",
    { noInput: true, log: () => {} },
  );
  assertEquals(picked, undefined);
});

Deno.test("computeChooser asks once however often a create is retried", async () => {
  let contexts = 0;
  const c = clientWithComputes([CPU("s1", "pro-1"), CPU("s2", "pro-2")]);
  const inner = c.deployContext;
  c.deployContext = (id: string) => {
    contexts++;
    return inner(id);
  };
  const ask = computeChooser(c, "p1", {
    noInput: false,
    log: () => {},
    io: fakeIO(["1"]),
  });
  assertEquals(await ask(), "s2");
  assertEquals(await ask(), "s2");
  assertEquals(contexts, 1);
});

Deno.test("chooseCompute refuses to fall back to shared compute on Pro", async () => {
  await assertRejects(
    () =>
      chooseCompute(clientWithComputes([]), "p1", {
        noInput: true,
        log: () => {},
      }),
    CliError,
    "No running compute on this account yet",
  );
});

Deno.test("chooseCompute points a developer at the owner when their compute is down", async () => {
  await assertRejects(
    () =>
      chooseCompute(clientWithComputes([], { isOwner: false }), "p1", {
        noInput: true,
        log: () => {},
      }),
    CliError,
    "The project owner has no running compute",
  );
});


Deno.test("pollStatus stops at terminal state", async () => {
  const c = createMockCloudClient();
  const made = await c.createResource("pocketbases", {
    name: "db1",
    project: "p1",
  });
  await c.updateResource("pocketbases", made.id, { status: "running" });
  const final = await pollStatus(c, "pocketbases", made.id, {
    terminal: ["running", "error"],
    timeoutMs: 1000,
    intervalMs: 10,
  });
  assertEquals(final.status, "running");
});

Deno.test("pollStatus prints a line only when the status changes", async () => {
  const seen: string[] = [];
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const r = await client.createResource("pocketbases", {
    name: "db",
    project: p.id,
  });
  let n = 0;
  client.getResource = (_k, id) =>
    Promise.resolve(
      { id, name: "db", status: ++n < 4 ? "creating" : "running" } as never,
    );
  const final = await pollStatus(client, "pocketbases", r.id, {
    terminal: ["running"],
    timeoutMs: 10_000,
    intervalMs: 0,
    onTick: (s) => seen.push(s),
  });
  assertEquals(final.status, "running");
  assertEquals(seen, ["creating", "running"]);
});

Deno.test("a poll timeout names the resource and how to recover", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const r = await client.createResource("pocketbases", {
    name: "db",
    project: p.id,
  });
  client.getResource = (_k, id) =>
    Promise.resolve({ id, name: "stuck-db", status: "creating" } as never);
  const err = await assertRejects(() =>
    pollStatus(client, "pocketbases", r.id, {
      terminal: ["running"],
      timeoutMs: -1,
      intervalMs: 0,
      label: "PocketBase",
      checkCommand: "pocketbase",
    })
  );
  const msg = (err as Error).message;
  assertStringIncludes(msg, "stuck-db");
  assertStringIncludes(msg, "still be provisioning");
  assertStringIncludes(msg, "pbc pocketbase info --name stuck-db");
  assertStringIncludes(msg, "pbc pocketbase rm --name stuck-db");
});

Deno.test("awaitDeployment follows the platform's status in one step", async () => {
  const lines: string[] = [];
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const r = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  let n = 0;
  client.getResource = (_k, id) =>
    Promise.resolve(
      { id, name: "api", status: ++n < 3 ? "creating" : "running" } as never,
    );
  const final = await awaitDeployment(client, "backends", r, {
    progress: plainProgress((m) => lines.push(m)),
    created: true,
    environment: "production",
    label: "backend",
    checkCommand: "backend",
    intervalMs: 0,
  });
  assertEquals(final.status, "running");
  assertStringIncludes(lines[0], "Creating api (environment: production)");
  assertStringIncludes(lines.join("\n"), "— creating");
  assertEquals(lines[lines.length - 1], "✓ api is running");
});

Deno.test("awaitDeployment marks the step failed when the deploy does not run", async () => {
  const lines: string[] = [];
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const r = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  client.getResource = (_k, id) =>
    Promise.resolve({ id, name: "api", status: "failed" } as never);
  const final = await awaitDeployment(client, "backends", r, {
    progress: plainProgress((m) => lines.push(m)),
    created: false,
    environment: "production",
    label: "backend",
    checkCommand: "backend",
    intervalMs: 0,
  });
  assertEquals(final.status, "failed");
  assertStringIncludes(lines[0], "Redeploying api");
  assertEquals(lines[lines.length - 1], "✗ api is failed");
});

Deno.test("reportUrl names the resource URL and any extra path", () => {
  const out: string[] = [];
  const url = reportUrl(
    { ...R("r1", "db"), baseUrl: "https://db.example.com" } as never,
    { log: (m) => out.push(m), paths: [{ path: "/_/", label: "admin" }] },
  );
  assertEquals(url, "https://db.example.com");
  assertEquals(out, [
    "  https://db.example.com",
    "  https://db.example.com/_/ (admin)",
  ]);
});

Deno.test("reportUrl falls back to the domain field", () => {
  const out: string[] = [];
  const url = reportUrl(
    { ...R("r2", "web"), domain: "web.example.com" } as never,
    { log: (m) => out.push(m) },
  );
  assertEquals(url, "https://web.example.com");
  assertEquals(out, ["  https://web.example.com"]);
});

Deno.test("reportUrl prints a verified custom domain beside the platform URL", () => {
  const out: string[] = [];
  const url = reportUrl(
    {
      ...R("r4", "web"),
      domain: "web.example.com",
      custom_domain: "app.mysite.com",
      custom_domain_status: "verified",
    },
    { log: (m) => out.push(m) },
  );
  assertEquals(url, "https://web.example.com");
  assertEquals(out, [
    "  https://web.example.com",
    "  https://app.mysite.com (custom domain)",
  ]);
});

Deno.test("an unverified custom domain is printed with its status", () => {
  const out: string[] = [];
  reportUrl(
    {
      ...R("r5", "api"),
      domain: "api.example.com",
      custom_domain: "api.mysite.com",
      custom_domain_status: "pending",
    },
    { log: (m) => out.push(m) },
  );
  assertEquals(out[1], "  https://api.mysite.com (custom domain — pending)");
});

Deno.test("a resource with no custom domain prints only its own URL", () => {
  const out: string[] = [];
  reportUrl(
    { ...R("r6", "db"), domain: "db.example.com" },
    { log: (m) => out.push(m), paths: [{ path: "/_/", label: "admin" }] },
  );
  assertEquals(out.length, 2);
});

Deno.test("reportUrl says nothing for a resource with no domain yet", () => {
  const out: string[] = [];
  assertEquals(
    reportUrl(R("r3", "api"), { log: (m) => out.push(m) }),
    undefined,
  );
  assertEquals(out, []);
});

Deno.test("awaitReachable stops once the domain answers", async () => {
  const client = createMockCloudClient();
  let probes = 0;
  client.ext = (path, body) => {
    client.calls.ext.push([path, body]);
    probes++;
    return Promise.resolve(
      new Response(null, { status: probes < 3 ? 503 : 200 }),
    );
  };
  const out: string[] = [];
  const reachable = await awaitReachable(client, {
    type: "pocketbase",
    resource: { ...R("r1", "db"), baseUrl: "https://db.example.com" } as never,
    log: (m) => out.push(m),
    intervalMs: 0,
  });
  assertEquals(reachable, true);
  assertEquals(probes, 3);
  assertStringIncludes(out.join("\n"), "Reachable.");
  assertEquals(client.calls.ext[0][0], "/api/domain/verify-reachability");
  const body = client.calls.ext[0][1] as { type: string; id: string };
  assertEquals(body, { type: "pocketbase", id: "r1" });
});

Deno.test("awaitReachable gives up without failing the deploy", async () => {
  const client = createMockCloudClient();
  client.ext = () => Promise.resolve(new Response(null, { status: 503 }));
  const out: string[] = [];
  const reachable = await awaitReachable(client, {
    type: "frontend",
    resource: { ...R("r2", "web"), domain: "web.example.com" } as never,
    log: (m) => out.push(m),
    timeoutMs: -1,
    intervalMs: 0,
  });
  assertEquals(reachable, false);
  assertStringIncludes(out.join("\n"), "Not reachable yet");
});

Deno.test("awaitReachable skips a resource that has no domain yet", async () => {
  const client = createMockCloudClient();
  const out: string[] = [];
  const reachable = await awaitReachable(client, {
    type: "backend",
    resource: R("r3", "api"),
    log: (m) => out.push(m),
    intervalMs: 0,
  });
  assertEquals(reachable, false);
  assertEquals(out, []);
  assertEquals(client.calls.ext.length, 0);
});

Deno.test("assertArchiveWithinLimit accepts an archive at the limit", () => {
  assertArchiveWithinLimit(new Uint8Array(MAX_ARCHIVE_BYTES), "app.zip");
});

Deno.test("assertArchiveWithinLimit rejects an over-limit archive by name and size", () => {
  const err = assertThrows(
    () =>
      assertArchiveWithinLimit(
        new Uint8Array(MAX_ARCHIVE_BYTES + 1024 * 1024),
        "app.zip",
      ),
    CliError,
  );

  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  assertStringIncludes(err.message, "app.zip");
  assertStringIncludes(err.message, mb(MAX_ARCHIVE_BYTES + 1024 * 1024));
  assertStringIncludes(err.message, `${mb(MAX_ARCHIVE_BYTES)} limit`);
  assertEquals(err.exitCode, 2);
});

Deno.test("validateLocationChoice - accepts a region the pool has", async () => {
  const client = createMockCloudClient();
  client.deployContext = () =>
    Promise.resolve({
      ownerPlan: "starter",
      isOwner: true,
      organization: "",
      servers: [],
      locations: ["hil", "sin"],
    });

  await validateLocationChoice(client, "p1", "sin");
});

Deno.test(
  "validateLocationChoice - rejects an unbacked region with the pool list",
  async () => {
    const client = createMockCloudClient();
    client.deployContext = () =>
      Promise.resolve({
        ownerPlan: "starter",
        isOwner: true,
        organization: "",
        servers: [],
        locations: ["hil", "sin"],
      });

    const err = await assertRejects(
      () => validateLocationChoice(client, "p1", "fsn1"),
      CliError,
    );
    assertStringIncludes(err.message, `--location "fsn1" is not available`);
    assertStringIncludes(err.message, "hil, sin");
    assertEquals(err.exitCode, 2);
  },
);

Deno.test(
  "validateLocationChoice - passes through when the backend predates locations",
  async () => {
    const client = createMockCloudClient();
    client.deployContext = () =>
      Promise.resolve({
        ownerPlan: "starter",
        isOwner: true,
        organization: "",
        servers: [],
      });

    await validateLocationChoice(client, "p1", "fsn1");
  },
);

Deno.test("resolveTarget: the refusal names the parent file that binds", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(root, "pb.json"),
      JSON.stringify({
        projectId: "p1",
        kind: "frontends",
        defaultEnvironment: "production",
        environments: { production: { id: "fe1", name: "web" } },
      }),
    );
    const sub = join(root, "apps", "web");
    await Deno.mkdir(sub, { recursive: true });
    const err = await assertRejects(
      () => resolveEnvironmentTarget({}, "backends", sub, { strictKind: true }),
      Error,
      "pb.json is bound to frontends",
    );
    assertEquals((err as Error).message.includes("pbc.json"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
