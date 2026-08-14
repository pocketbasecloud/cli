import { assertEquals } from "@std/assert";
import {
  envKeysOf,
  makeEnvCommands,
  parseDotenv,
  prunedKeysOf,
} from "../../../src/commands/env.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { tempStatePath } from "../../mocks/state.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import { join } from "@std/path";

Deno.test("parseDotenv ignores comments and blanks", () => {
  assertEquals(parseDotenv("# c\nA=1\n\nB=two words\n"), {
    A: "1",
    B: "two words",
  });
});

Deno.test("env import posts bulk-set with parsed vars", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, ".env"), "A=1\nB=2\n");
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const be = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeEnvCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
    envStatePath: tempStatePath(),
  });
  const code = await cmds["cloud env import"]({
    args: [join(dir, ".env")],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
    raw: { target: "backend", name: "api" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.ext[0][0], "/api/env/bulk-set");
  const body = client.calls.ext[0][1] as {
    target_id: string;
    type: string;
    variables: Record<string, string>;
  };
  assertEquals(body.target_id, be.id);
  assertEquals(body.type, "backend");
  assertEquals(body.variables, { A: "1", B: "2" });
  // Merging is the default — a cloud-only key survives an import.
  assertEquals((body as unknown as { prune: boolean }).prune, false);
});

Deno.test("env import --delete-missing asks the platform to prune", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, ".env"), "A=1\n");
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("backends", { name: "api", project: p.id });
  client.ext = (path: string, body: unknown) => {
    (client.calls.ext as [string, unknown][]).push([path, body]);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          status: "success",
          details: { succeeded: 1, pruned: ["OLD"], pruned_count: 1 },
        }),
        { status: 200 },
      ),
    );
  };
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => logs.push(s);
  try {
    const cmds = makeEnvCommands({
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => "/tmp",
      envStatePath: tempStatePath(),
    });
    const code = await cmds["cloud env import"]({
      args: [join(dir, ".env")],
      flags: {
        json: true,
        // --yes stands in for the confirmation this destructive form asks for.
        yes: true,
        noInput: true,
        interactive: false,
        project: p.id,
      },
      raw: { target: "backend", name: "api", "delete-missing": true },
    });
    assertEquals(code, 0);
    assertEquals(
      (client.calls.ext[0][1] as { prune: boolean }).prune,
      true,
    );
    assertEquals(JSON.parse(logs[0]), { imported: 1, removed: ["OLD"] });
  } finally {
    console.log = origLog;
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prunedKeysOf reads details.pruned and tolerates its absence", () => {
  assertEquals(prunedKeysOf({ details: { pruned: ["A", "B"] } }), ["A", "B"]);
  assertEquals(prunedKeysOf({ pruned: ["A"] }), ["A"]);
  assertEquals(prunedKeysOf({ details: { succeeded: 1 } }), []);
  assertEquals(prunedKeysOf({}), []);
  assertEquals(prunedKeysOf(undefined), []);
});

Deno.test("env set --env writes to that environment's backend", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const prod = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  const staging = await client.createResource("backends", {
    name: "api-staging",
    project: p.id,
  });
  const cwd = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(cwd, "pb.json"),
    JSON.stringify({
      projectId: p.id,
      kind: "backends",
      defaultEnvironment: "production",
      environments: {
        production: { id: prod.id, name: "api" },
        staging: { id: staging.id, name: "api-staging" },
      },
    }),
  );
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeEnvCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    envStatePath: tempStatePath(),
  });
  const flags = {
    json: true,
    yes: true,
    noInput: true,
    interactive: false,
    project: p.id,
  };
  await cmds["cloud env set"]({
    args: ["A=1"],
    flags,
    raw: { target: "backend", env: "staging" },
  });
  // set/list/delete are service-key guarded on backend-extension, so the CLI
  // reaches them through PocketBase, which holds that key.
  assertEquals(
    (client.calls.pbApi[0][1] as { target_id: string }).target_id,
    staging.id,
  );
  // With no --env, the file's default environment.
  await cmds["cloud env set"]({
    args: ["A=1"],
    flags,
    raw: { target: "backend" },
  });
  assertEquals(
    (client.calls.pbApi[1][1] as { target_id: string }).target_id,
    prod.id,
  );
  await Deno.remove(cwd, { recursive: true });
});

Deno.test("envKeysOf reads the details.variables envelope, sorted", () => {
  const body = {
    status: "success",
    operation: "list-env",
    details: { variables: { FOO: "enc1", BAR: "enc2" }, count: 2 },
    execution_time: 0.01,
  };
  assertEquals(envKeysOf(body), ["BAR", "FOO"]);
});

Deno.test("envKeysOf tolerates a flat {variables} shape and emptiness", () => {
  assertEquals(envKeysOf({ variables: { A: "x" } }), ["A"]);
  assertEquals(envKeysOf({ details: { variables: {} } }), []);
  assertEquals(envKeysOf({}), []);
});

Deno.test("env ls emits a flat [{key}] array under --json", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const be = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => logs.push(s);
  try {
    const cmds = makeEnvCommands({
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => "/tmp",
      envStatePath: tempStatePath(),
    });
    // Override pbApi to answer /api/env/list with the real envelope shape.
    client.pbApi = (path: string, body: unknown) => {
      (client.calls.pbApi as [string, unknown][]).push([path, body]);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "success",
            details: { variables: { B: "enc", A: "enc" }, count: 2 },
          }),
          { status: 200 },
        ),
      );
    };
    const code = await cmds["cloud env ls"]({
      args: [],
      flags: {
        json: true,
        yes: false,
        noInput: true,
        interactive: false,
        project: p.id,
      },
      raw: { target: "backend", name: "api" },
    });
    assertEquals(code, 0);
    assertEquals(client.calls.pbApi[0][0], "/api/env/list");
    assertEquals(
      (client.calls.pbApi[0][1] as { target_id: string }).target_id,
      be.id,
    );
    assertEquals(JSON.parse(logs[0]), [{ key: "A" }, { key: "B" }]);
  } finally {
    console.log = origLog;
  }
});

Deno.test("env ls announces the project resolved from config.currentProject", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("backends", { name: "api", project: p.id });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => logs.push(s);
  try {
    const cmds = makeEnvCommands({
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => "/tmp",
      envStatePath: tempStatePath(),
    });
    const code = await cmds["cloud env ls"]({
      args: [],
      flags: { json: false, yes: false, noInput: true, interactive: false },
      raw: { target: "backend", name: "api" },
    });
    assertEquals(code, 0);
    assertEquals(logs[0].includes(`Project: ${p.name}`), true);
    assertEquals(logs[0].includes("pb cloud project use"), true);
  } finally {
    console.log = origLog;
  }
});

Deno.test("env ls does not announce the project when --project names it", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("backends", { name: "api", project: p.id });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => logs.push(s);
  try {
    const cmds = makeEnvCommands({
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => "/tmp",
      envStatePath: tempStatePath(),
    });
    await cmds["cloud env ls"]({
      args: [],
      flags: {
        json: false,
        yes: false,
        noInput: true,
        interactive: false,
        project: p.id,
      },
      raw: { target: "backend", name: "api" },
    });
    assertEquals(logs.some((l) => l.startsWith("Project:")), false);
  } finally {
    console.log = origLog;
  }
});
