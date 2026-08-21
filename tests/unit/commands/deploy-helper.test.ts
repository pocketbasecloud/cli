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
  computeFlag,
  deployResource,
  ensureTarget,
  findExisting,
  MAX_ARCHIVE_BYTES,
  missingTargetMessage,
  pollStatus,
  reportUrl,
  resolveExisting,
  resolveOwnerId,
  resolveTarget,
  suggestName,
  validateLocationChoice,
} from "../../../src/commands/deploy-helper.ts";
import type { Target } from "../../../src/commands/deploy-helper.ts";
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

Deno.test("resolveExisting returns the unique match by name", async () => {
  const found = await resolveExisting([R("a", "one"), R("b", "two")], {
    name: "two",
  }, { label: "backend", noInput: false });
  assertEquals(found.id, "b");
});

Deno.test("resolveExisting selects from the list when it can prompt", async () => {
  const found = await resolveExisting([R("a", "one"), R("b", "two")], {}, {
    label: "backend",
    noInput: false,
    io: fakeIO(["2"]),
  });
  assertEquals(found.id, "b");
});

Deno.test("resolveExisting errors when nothing exists", async () => {
  await assertRejects(
    () =>
      resolveExisting([], {}, {
        label: "backend",
        noInput: false,
        io: fakeIO([]),
      }),
    Error,
    "No backend found.",
  );
});

Deno.test("resolveExisting throws the standard error when it cannot ask", async () => {
  await assertRejects(
    () =>
      resolveExisting([R("a", "one"), R("b", "one")], { name: "one" }, {
        label: "backend",
        noInput: false,
      }),
    Error,
    "Specify a unique --name or --id.",
  );
});

Deno.test("resolveExisting refuses to prompt under --json even on a TTY", async () => {
  await assertRejects(
    () =>
      resolveExisting([R("a", "one"), R("b", "two")], {}, {
        label: "backend",
        noInput: true,
        io: fakeIO(["2"]),
      }),
    Error,
    "Specify a unique --name or --id.",
  );
});

Deno.test("resolveExisting honors a custom error message", async () => {
  await assertRejects(
    () =>
      resolveExisting([R("a", "one")], {}, {
        label: "pocketbase",
        noInput: false,
        errorMessage: "Specify a unique --name or --id for the pocketbase.",
      }),
    Error,
    "for the pocketbase.",
  );
});

Deno.test("deployResource creates when none exists", async () => {
  const c = createMockCloudClient();
  const { created } = await deployResource(c, "pocketbases", "p1", {
    name: "db1",
    data: { name: "db1", project: "p1" },
  });
  assertEquals(created, true);
});

Deno.test("deployResource updates when name exists", async () => {
  const c = createMockCloudClient();
  const made = await c.createResource("pocketbases", {
    name: "db1",
    project: "p1",
  });
  const { created, resource } = await deployResource(c, "pocketbases", "p1", {
    name: "db1",
    data: { note: "x" },
  });
  assertEquals(created, false);
  assertEquals(resource.id, made.id);
});

/** A pbc.json with production+staging frontends, or none at all. */
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

Deno.test("resolveTarget: explicit id/name wins over any binding", async () => {
  const dir = await withBinding(true);
  try {
    assertEquals(await resolveTarget({ id: "x" }, "frontends", dir), {
      id: "x",
      fromBinding: false,
      environment: "production",
      hasEnvironments: true,
    });
    assertEquals(await resolveTarget({ name: "y" }, "frontends", dir), {
      name: "y",
      fromBinding: false,
      environment: "production",
      hasEnvironments: true,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveTarget: falls back to the default environment's entry", async () => {
  const dir = await withBinding(true);
  try {
    assertEquals(await resolveTarget({}, "frontends", dir), {
      id: "fe1",
      fromBinding: true,
      environment: "production",
      hasEnvironments: true,
    });
    // A file bound to a different kind is ignored, as before environments.
    assertEquals(await resolveTarget({}, "backends", dir), {
      fromBinding: false,
      environment: "production",
      hasEnvironments: true,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveTarget: --env picks that environment's entry", async () => {
  const dir = await withBinding(true);
  try {
    assertEquals(
      await resolveTarget({}, "frontends", dir, { envFlag: "staging" }),
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

Deno.test("resolveTarget: an unconfigured --env is an error", async () => {
  const dir = await withBinding(true);
  try {
    await assertRejects(
      () => resolveTarget({}, "frontends", dir, { envFlag: "preview" }),
      Error,
      'Unknown environment "preview". Configured: production, staging.',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveTarget: strictKind refuses a directory bound to another kind", async () => {
  const dir = await withBinding(true);
  try {
    await assertRejects(
      () => resolveTarget({}, "backends", dir, { strictKind: true }),
      Error,
      "pbc.json is bound to frontends — deploy backends from a different",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveTarget: no flags and no binding yields nothing", async () => {
  const dir = await withBinding(false);
  try {
    assertEquals(await resolveTarget({}, "frontends", dir), {
      fromBinding: false,
      environment: "production",
      hasEnvironments: false,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("missingTargetMessage distinguishes an unconfigured env from a fresh directory", () => {
  assertEquals(
    missingTargetMessage(
      { fromBinding: false, environment: "staging", hasEnvironments: true },
      "frontend",
    ),
    'Environment "staging" is not configured — pass --name to create it.',
  );
  assertEquals(
    missingTargetMessage(
      { fromBinding: false, environment: "production", hasEnvironments: false },
      "frontend",
    ),
    "Pass --name to create the first frontend, or remove --no-input / --json " +
      "to be asked interactively.",
  );
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

Deno.test("ensureTarget leaves a named target alone without listing", async () => {
  let listed = false;
  const t = await ensureTarget({ ...EMPTY, name: "web" }, {
    label: "frontend",
    cwd: "/tmp/app",
    list: () => {
      listed = true;
      return Promise.resolve([]);
    },
    noInput: false,
    io: fakeIO([]),
  });
  assertEquals(t.name, "web");
  assertEquals(listed, false);
});

Deno.test("ensureTarget keeps the usage error when it cannot ask", async () => {
  await assertRejects(
    () =>
      ensureTarget(EMPTY, {
        label: "frontend",
        cwd: "/tmp/app",
        list: () => Promise.resolve([]),
        noInput: true,
      }),
    Error,
    "Pass --name to create the first frontend, or",
  );
});

Deno.test("ensureTarget selects an existing resource to redeploy", async () => {
  const t = await ensureTarget(EMPTY, {
    label: "frontend",
    cwd: "/tmp/app",
    list: () => Promise.resolve([R("a", "one"), R("b", "two")]),
    noInput: false,
    io: fakeIO(["2"]),
  });
  assertEquals([t.id, t.name], ["b", "two"]);
  // Not a binding, so a since-deleted pick still falls through to a create.
  assertEquals(t.fromBinding, false);
});

Deno.test("ensureTarget asks for a name after the create-new entry", async () => {
  const t = await ensureTarget(EMPTY, {
    label: "frontend",
    cwd: "/tmp/app",
    list: () => Promise.resolve([R("a", "one")]),
    noInput: false,
    io: fakeIO(["2", "site"]),
  });
  assertEquals([t.id, t.name], [undefined, "site"]);
});

Deno.test("ensureTarget skips the menu and defaults the name when nothing exists", async () => {
  const t = await ensureTarget(EMPTY, {
    label: "frontend",
    cwd: "/tmp/My React App",
    list: () => Promise.resolve([]),
    noInput: false,
    io: fakeIO([""]),
  });
  assertEquals(t.name, "my-react-app");
});

Deno.test("resolveOwnerId prefers the stored id and falls back to whoami", async () => {
  const c = createMockCloudClient();
  assertEquals(await resolveOwnerId(c, { userId: "u9" }), "u9");
  // Token-only auth (PBC_TOKEN) stores no id.
  assertEquals(await resolveOwnerId(c, { userId: "" }), "u1");
});

Deno.test("computeFlag reads --compute, and still honours the old --server", () => {
  assertEquals(computeFlag({ compute: "s1" }), "s1");
  // Pinned scripts and CI predate the rename; breaking them buys nothing.
  assertEquals(computeFlag({ server: "s2" }), "s2");
  assertEquals(computeFlag({ compute: "s1", server: "s2" }), "s1");
  assertEquals(computeFlag({}), undefined);
});

/** A client whose deploy-context answers with exactly these computes. */
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
  // Named the way the portal names it — never by the internal record name.
  assertStringIncludes(said[0], "Compute 1 — Gravelines");
  assertStringIncludes(said[0], "s1");
});

Deno.test("chooseCompute offers an organization's compute off Pro", async () => {
  // A project shared into an organization is owned by the org owner, so its
  // compute is the organization's — offered whatever the plan lookup says.
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
  // An organization whose owner is not on Pro has no dedicated compute at all;
  // the shared pool is the right answer, not an error.
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
  // deploy-context is newest-first, so the menu's first entry is the oldest.
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
  // Free/starter deploys are auto-placed in the shared pool by capacity, and
  // a plan that cannot deploy at all gets the platform's own message. Compute
  // the owner happens to have is not theirs to pick from outside Pro/an org.
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
    io: fakeIO(["1"]), // One answer only: a second menu would hang.
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
  // The developer cannot provision compute in someone else's organization, so
  // the message has to name who can.
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

Deno.test("deployResource errors on a stale binding and runs onStale", async () => {
  const c = createMockCloudClient();
  let cleared = false;
  await assertRejects(
    () =>
      deployResource(c, "frontends", "p1", {
        id: "gone",
        data: { project: "p1" },
        requireExisting: true,
        onStale: () => {
          cleared = true;
          return Promise.resolve();
        },
      }),
    Error,
    "no longer exists",
  );
  assertEquals(cleared, true);
  assertEquals(c.calls.createResource.length, 0);
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
  // Four polls, two distinct statuses.
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
      timeoutMs: -1, // already past the deadline
      intervalMs: 0,
      label: "PocketBase",
      checkCommand: "pb",
    })
  );
  const msg = (err as Error).message;
  assertStringIncludes(msg, "stuck-db");
  assertStringIncludes(msg, "still be provisioning");
  assertStringIncludes(msg, "pbc cloud pb info --name stuck-db");
  assertStringIncludes(msg, "pbc cloud pb rm --name stuck-db");
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
  // The step says what the platform last reported, then closes with the answer.
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
  // The platform URL still comes first — it is the one that always works —
  // and the user's own domain follows it.
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
  // Saying "pending" here is the point: the deploy worked, the domain does not
  // answer yet, and those two facts arrive together.
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
    // 503 until the certificate is issued, which is what the route reports.
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
    timeoutMs: -1, // already past the deadline
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

// ===================================================================
// Archive size pre-flight
// ===================================================================

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

  // The point of failing here rather than on upload: the user is told what
  // went wrong and roughly what to do, before transferring the whole archive.
  // Both figures are derived from MAX_ARCHIVE_BYTES so that raising the cap
  // cannot leave this asserting the old one, which is what it did.
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

    // Must not throw: against an older backend there is nothing to check, and
    // guessing would break deploys the platform would have placed fine.
    await validateLocationChoice(client, "p1", "fsn1");
  },
);

Deno.test("resolveTarget: the refusal names the parent file that binds", async () => {
  // The binding is found by walking up, so a subdirectory of a monorepo whose
  // root still holds pb.json must be told about pb.json — not about the
  // pbc.json it would write if it ever had one.
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
      () => resolveTarget({}, "backends", sub, { strictKind: true }),
      Error,
      "pb.json is bound to frontends",
    );
    assertEquals((err as Error).message.includes("pbc.json"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
