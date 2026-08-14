import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { matchProject, resolveProject } from "../../src/resolve/project.ts";
import { createMockCloudClient } from "../mocks/cloud.mock.ts";
import { defaultConfig } from "../../src/config.ts";
import type { Project } from "../../src/clients/types.ts";

const P = (id: string, name: string): Project => ({
  id,
  name,
  user: "u1",
  organization: "",
  createdBy: "u1",
});

Deno.test("matchProject matches id first", () => {
  const ps = [P("abc", "one"), P("def", "two")];
  const m = matchProject(ps, "abc");
  assertEquals(m !== "ambiguous" ? m?.name : undefined, "one");
});

Deno.test("matchProject matches unique name", () => {
  const ps = [P("abc", "one"), P("def", "two")];
  const m = matchProject(ps, "two");
  assertEquals(m !== "ambiguous" ? m?.id : undefined, "def");
});

Deno.test("matchProject flags ambiguous names", () => {
  const ps = [P("abc", "dup"), P("def", "dup")];
  assertEquals(matchProject(ps, "dup"), "ambiguous");
});

Deno.test("resolveProject uses flag", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const result = await resolveProject({
    client,
    config: defaultConfig(),
    cwd: "/tmp/none",
    flagProject: p.id,
    noInput: true,
  });
  assertEquals(result.id, p.id);
});

Deno.test("resolveProject errors under no-input with no context", async () => {
  const client = createMockCloudClient();
  await client.createProject("app");
  await assertRejects(() =>
    resolveProject({
      client,
      config: defaultConfig(),
      cwd: "/tmp/none",
      noInput: true,
    })
  );
});

Deno.test("resolveProject on a non-TTY gives the actionable message, not the generic one", async () => {
  const client = createMockCloudClient();
  await client.createProject("app");
  const err = await assertRejects(() =>
    resolveProject({
      client,
      config: defaultConfig(),
      cwd: "/tmp/none",
      // noInput false, but stdin is not a terminal — a menu would hang.
      noInput: false,
      io: { read: () => Promise.resolve(null), write: () => {}, isTTY: false },
    })
  );
  assertEquals((err as Error).message.includes("No project selected"), true);
});

Deno.test("resolveProject announces a project resolved from a linked pb.json", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({
        projectId: p.id,
        kind: "frontends",
        defaultEnvironment: "production",
        environments: { production: { id: "r1", name: "web" } },
      }),
    );
    const lines: string[] = [];
    const result = await resolveProject({
      client,
      config: defaultConfig(),
      cwd: dir,
      noInput: true,
      log: (m) => lines.push(m),
    });
    assertEquals(result.id, p.id);
    assertEquals(lines.length, 1);
    assertEquals(lines[0].includes(p.name), true);
    assertEquals(lines[0].includes(p.id), true);
    assertEquals(lines[0].includes("linked in ./pb.json"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveProject announces a project resolved from config.currentProject", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const config = defaultConfig();
  config.currentProject = p.id;
  const lines: string[] = [];
  const result = await resolveProject({
    client,
    config,
    cwd: "/tmp/none",
    noInput: true,
    log: (m) => lines.push(m),
  });
  assertEquals(result.id, p.id);
  assertEquals(lines.length, 1);
  assertEquals(lines[0].includes("pb cloud project use"), true);
});

Deno.test("resolveProject never announces when --project resolved it", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const lines: string[] = [];
  await resolveProject({
    client,
    config: defaultConfig(),
    cwd: "/tmp/none",
    flagProject: p.id,
    noInput: true,
    log: (m) => lines.push(m),
  });
  assertEquals(lines, []);
});

Deno.test("resolveProject never announces the interactive pick — it is already on screen", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const lines: string[] = [];
  const result = await resolveProject({
    client,
    config: defaultConfig(),
    cwd: "/tmp/none",
    noInput: false,
    io: { read: () => Promise.resolve("1"), write: () => {}, isTTY: true },
    log: (m) => lines.push(m),
  });
  assertEquals(result.id, p.id);
  assertEquals(lines, []);
});
