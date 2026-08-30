import { assertEquals } from "@std/assert";
import { makeProjectCommands } from "../../../src/commands/project.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";

function deps(opts: { cwd?: string } = {}) {
  const client = createMockCloudClient();
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  return {
    client,
    config,
    d: {
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: (c: Config) => {
        Object.assign(config, c);
        return Promise.resolve();
      },
      cwd: () => opts.cwd ?? "/tmp",
    },
  };
}

Deno.test("project create adds a project", async () => {
  const { client, d } = deps();
  const cmds = makeProjectCommands(d);
  const code = await cmds["project create"].run({}, {
    args: ["myapp"],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
  assertEquals(
    (await client.listProjects()).some((p) => p.name === "myapp"),
    true,
  );
});

Deno.test("project use stores currentProject", async () => {
  const { client, config, d } = deps();
  const p = await client.createProject("app");
  const cmds = makeProjectCommands(d);
  await cmds["project use"].run({}, {
    args: [p.id],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(config.currentProject, p.id);
});
