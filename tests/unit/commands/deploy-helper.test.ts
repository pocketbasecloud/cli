import { assertEquals, assertRejects } from "@std/assert";
import {
  deployResource,
  findExisting,
  pollStatus,
  resolveExisting,
} from "../../../src/commands/deploy-helper.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import type { Resource } from "../../../src/clients/types.ts";
import type { PromptIO } from "../../../src/ui/prompt.ts";

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
