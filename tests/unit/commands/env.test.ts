import { assertEquals } from "@std/assert";
import { makeEnvCommands, parseDotenv } from "../../../src/commands/env.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
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
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeEnvCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
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
    vars: Record<string, string>;
  };
  assertEquals(body.target_id, be.id);
  assertEquals(body.type, "backend");
  assertEquals(body.vars, { A: "1", B: "2" });
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
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeEnvCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
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
  assertEquals(
    (client.calls.ext[0][1] as { target_id: string }).target_id,
    staging.id,
  );
  // With no --env, the file's default environment.
  await cmds["cloud env set"]({
    args: ["A=1"],
    flags,
    raw: { target: "backend" },
  });
  assertEquals(
    (client.calls.ext[1][1] as { target_id: string }).target_id,
    prod.id,
  );
  await Deno.remove(cwd, { recursive: true });
});
