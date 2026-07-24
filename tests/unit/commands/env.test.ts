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
    flags: { json: true, yes: true, noInput: true, project: p.id },
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
