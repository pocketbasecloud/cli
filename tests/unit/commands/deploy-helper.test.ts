import { assertEquals, assertRejects } from "@std/assert";
import {
  deployResource,
  findExisting,
  missingTargetMessage,
  pollStatus,
  resolveExisting,
  resolveTarget,
} from "../../../src/commands/deploy-helper.ts";
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
