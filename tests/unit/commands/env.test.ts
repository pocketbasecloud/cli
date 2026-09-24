import { assertEquals, assertRejects } from "@std/assert";
import { CliError } from "../../../src/errors.ts";
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

Deno.test("parseDotenv handles quotes, exports, escapes and inline comments", () => {
  assertEquals(
    parseDotenv(
      [
        'A="a b "',
        "export B='c d'",
        'C="line1\\nline2"',
        "D=plain # trailing comment",
        "E=abc#def",
        'F=""',
        'G="say \\"hi\\""',
      ].join("\n"),
    ),
    {
      A: "a b ",
      B: "c d",
      C: "line1\nline2",
      D: "plain",
      E: "abc#def",
      F: "",
      G: 'say "hi"',
    },
  );
});

Deno.test("parseDotenv reads multi-line double-quoted values", () => {
  assertEquals(
    parseDotenv('KEY="-----BEGIN\nPRIVATE KEY-----"\nNEXT=1\n'),
    { KEY: "-----BEGIN\nPRIVATE KEY-----", NEXT: "1" },
  );
});

Deno.test("parseDotenv does not swallow lines after an unclosed single quote", () => {
  assertEquals(parseDotenv("A='oops\nB=1\n"), { A: "oops", B: "1" });
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
  const code = await cmds["env import"].run(
    { target: "backend", name: "api" },
    {
      args: [join(dir, ".env")],
      flags: {
        json: true,
        yes: true,
        noInput: true,
        interactive: false,
        project: p.id,
      },
    },
  );
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
    const code = await cmds["env import"].run(
      { target: "backend", name: "api", deleteMissing: true },
      {
        args: [join(dir, ".env")],
        flags: {
          json: true,
          yes: true,
          noInput: true,
          interactive: false,
          project: p.id,
        },
      },
    );
    assertEquals(code, 0);
    assertEquals(
      (client.calls.ext[0][1] as { prune: boolean }).prune,
      true,
    );
    assertEquals(JSON.parse(logs[0]).data, { imported: 1, removed: ["OLD"] });
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
    join(cwd, "pbc.json"),
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
  await cmds["env set"].run(
    { target: "backend", env: "staging" },
    { args: ["A=1"], flags },
  );
  assertEquals(
    (client.calls.pbApi[0][1] as { target_id: string }).target_id,
    staging.id,
  );
  await cmds["env set"].run(
    { target: "backend" },
    { args: ["A=1"], flags },
  );
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
    const code = await cmds["env ls"].run(
      { target: "backend", name: "api" },
      {
        args: [],
        flags: {
          json: true,
          yes: false,
          noInput: true,
          interactive: false,
          project: p.id,
        },
      },
    );
    assertEquals(code, 0);
    assertEquals(client.calls.pbApi[0][0], "/api/env/list");
    assertEquals(
      (client.calls.pbApi[0][1] as { target_id: string }).target_id,
      be.id,
    );
    assertEquals(JSON.parse(logs[0]).data, [{ key: "A" }, { key: "B" }]);
  } finally {
    console.log = origLog;
  }
});

Deno.test("env ls resolves a named backend across projects, no project step", async () => {
  const client = createMockCloudClient();
  await client.createProject("app");
  const other = await client.createProject("other");
  await client.createResource("backends", { name: "api", project: other.id });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (s: string) => errs.push(s);
  try {
    const cmds = makeEnvCommands({
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => "/tmp",
      envStatePath: tempStatePath(),
    });
    const code = await cmds["env ls"].run(
      { target: "backend", name: "api" },
      {
        args: [],
        flags: { json: false, yes: false, noInput: true, interactive: false },
      },
    );
    assertEquals(code, 0);
    assertEquals(errs.some((l) => l.startsWith("Project:")), false);
  } finally {
    console.error = origErr;
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
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (s: string) => errs.push(s);
  try {
    const cmds = makeEnvCommands({
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => "/tmp",
      envStatePath: tempStatePath(),
    });
    await cmds["env ls"].run(
      { target: "backend", name: "api" },
      {
        args: [],
        flags: {
          json: false,
          yes: false,
          noInput: true,
          interactive: false,
          project: p.id,
        },
      },
    );
    assertEquals(errs.some((l) => l.startsWith("Project:")), false);
  } finally {
    console.error = origErr;
  }
});

async function frontendEnvFixture(buildEnv?: Record<string, string>) {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const fe = await client.createResource("frontends", {
    name: "site",
    project: p.id,
  });
  if (buildEnv) {
    await client.updateResource("frontends", fe.id, { buildEnv });
    client.calls.updateResource.length = 0;
  }
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
  const flags = {
    json: true,
    yes: true,
    noInput: true,
    interactive: false,
    project: p.id,
  };
  return { client, cmds, fe, flags };
}

Deno.test("env set --target frontend merges into the frontend's buildEnv", async () => {
  const { client, cmds, fe, flags } = await frontendEnvFixture({ VITE_A: "1" });
  const code = await cmds["env set"].run(
    { target: "frontend", name: "site" },
    { args: ["VITE_B=https://api.example.com?x=1"], flags },
  );
  assertEquals(code, 0);
  assertEquals(client.calls.updateResource, [[
    "frontends",
    fe.id,
    { buildEnv: { VITE_A: "1", VITE_B: "https://api.example.com?x=1" } },
  ]]);
  assertEquals(client.calls.pbApi, []);
  assertEquals(client.calls.ext, []);
});

Deno.test("env rm --target frontend drops the key and clears an empty buildEnv", async () => {
  const { client, cmds, fe, flags } = await frontendEnvFixture({ VITE_A: "1" });
  await cmds["env rm"].run(
    { target: "frontend", name: "site" },
    { args: ["VITE_A"], flags },
  );
  assertEquals(client.calls.updateResource, [["frontends", fe.id, {
    buildEnv: null,
  }]]);
});

Deno.test("env ls --target frontend lists buildEnv names", async () => {
  const { cmds, flags } = await frontendEnvFixture({ VITE_B: "2", VITE_A: "1" });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => logs.push(s);
  try {
    await cmds["env ls"].run({ target: "frontend", name: "site" }, {
      args: [],
      flags,
    });
  } finally {
    console.log = origLog;
  }
  assertEquals(JSON.parse(logs[0]).data, [{ key: "VITE_A" }, { key: "VITE_B" }]);
});

Deno.test("env import --target frontend writes every variable, secrets included", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, ".env"),
    "VITE_A=1\nCMS_TOKEN=tok_x\n",
  );
  const { client, cmds, fe, flags } = await frontendEnvFixture();
  await cmds["env import"].run({ target: "frontend", name: "site" }, {
    args: [join(dir, ".env")],
    flags,
  });
  assertEquals(client.calls.updateResource, [[
    "frontends",
    fe.id,
    { buildEnv: { VITE_A: "1", CMS_TOKEN: "tok_x" } },
  ]]);
  assertEquals(client.calls.ext, []);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("env import --target frontend merges, or replaces with --delete-missing", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, ".env"), "VITE_B=2\n");
  const { client, cmds, fe, flags } = await frontendEnvFixture({ VITE_A: "1" });
  await cmds["env import"].run({ target: "frontend", name: "site" }, {
    args: [join(dir, ".env")],
    flags,
  });
  await cmds["env import"].run(
    { target: "frontend", name: "site", deleteMissing: true },
    { args: [join(dir, ".env")], flags },
  );
  assertEquals(client.calls.updateResource, [
    ["frontends", fe.id, { buildEnv: { VITE_A: "1", VITE_B: "2" } }],
    ["frontends", fe.id, { buildEnv: { VITE_B: "2" } }],
  ]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("env rm --target frontend on a variable that is not set fails without a write", async () => {
  const { client, cmds, flags } = await frontendEnvFixture({ VITE_A: "1" });
  const err = await assertRejects(() =>
    cmds["env rm"].run(
      { target: "frontend", name: "site" },
      { args: ["VITE_MISSING"], flags },
    )
  );
  assertEquals((err as CliError).code, "NOT_FOUND");
  assertEquals(client.calls.updateResource, []);
});
