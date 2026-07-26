import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  deployResource,
  ensureTarget,
  findExisting,
  isSubdomain,
  missingTargetMessage,
  pollStatus,
  resolveExisting,
  resolveOwnerId,
  resolveTarget,
  subdomainTaken,
  suffixSubdomain,
  suggestName,
  toSubdomain,
} from "../../../src/commands/deploy-helper.ts";
import type { Target } from "../../../src/commands/deploy-helper.ts";
import { CliError } from "../../../src/errors.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import type { Resource } from "../../../src/clients/types.ts";
import type { PromptIO } from "../../../src/ui/prompt.ts";
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
  }, { label: "backend", interactive: false, noInput: false });
  assertEquals(found.id, "b");
});

Deno.test("resolveExisting selects from the list when interactive and unresolved", async () => {
  const found = await resolveExisting([R("a", "one"), R("b", "two")], {}, {
    label: "backend",
    interactive: true,
    noInput: false,
    io: fakeIO(["2"]),
  });
  assertEquals(found.id, "b");
});

Deno.test("resolveExisting errors when interactive but nothing exists", async () => {
  await assertRejects(
    () =>
      resolveExisting([], {}, {
        label: "backend",
        interactive: true,
        noInput: false,
        io: fakeIO([]),
      }),
    Error,
    "No backend found.",
  );
});

Deno.test("resolveExisting throws the standard error when non-interactive and unresolved", async () => {
  await assertRejects(
    () =>
      resolveExisting([R("a", "one"), R("b", "one")], { name: "one" }, {
        label: "backend",
        interactive: false,
        noInput: false,
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
        interactive: false,
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

/** A pb.json with production+staging frontends, or none at all. */
async function withBinding(bound: boolean): Promise<string> {
  const dir = await Deno.makeTempDir();
  if (bound) {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
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
      "pb.json is bound to frontends — deploy backends from a different",
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
    "Pass --name to create the first frontend.",
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
    "Pass --name to create the first frontend.",
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

Deno.test("toSubdomain produces a label the frontends pattern accepts", () => {
  for (
    const [name, want] of [
      ["My Site", "my-site"],
      ["  Trailing!! ", "trailing"],
      ["9lives", "9lives"],
      ["!!!", "site"],
    ] as const
  ) {
    assertEquals(toSubdomain(name), want);
    assertEquals(isSubdomain(toSubdomain(name)), true);
  }
  const long = toSubdomain("x".repeat(200));
  assertEquals(long.length, 63);
  assertEquals(isSubdomain(long), true);
});

Deno.test("isSubdomain rejects what the collection rejects", () => {
  for (const bad of ["-lead", "trail-", "Upper", "has_underscore", ""]) {
    assertEquals(isSubdomain(bad), false);
  }
});

Deno.test("suffixSubdomain stays a valid label, even at the length limit", () => {
  const s = suffixSubdomain("x".repeat(63));
  assertEquals(s.length <= 63, true);
  assertEquals(isSubdomain(s), true);
});

Deno.test("subdomainTaken only matches the uniqueness code", () => {
  assertEquals(
    subdomainTaken(
      new CliError("x", 1, { subdomain: "validation_not_unique" }),
    ),
    true,
  );
  assertEquals(
    subdomainTaken(new CliError("x", 1, { subdomain: "validation_required" })),
    false,
  );
  assertEquals(subdomainTaken(new Error("x")), false);
});

Deno.test("resolveOwnerId prefers the stored id and falls back to whoami", async () => {
  const c = createMockCloudClient();
  assertEquals(await resolveOwnerId(c, { userId: "u9" }), "u9");
  // Token-only auth (PB_TOKEN) stores no id.
  assertEquals(await resolveOwnerId(c, { userId: "" }), "u1");
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
  assertStringIncludes(msg, "pb cloud pb info --name stuck-db");
  assertStringIncludes(msg, "pb cloud pb rm --name stuck-db");
});
