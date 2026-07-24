import { assertEquals } from "@std/assert";
import { makeProjectCommands } from "../../../src/commands/project.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";

function deps() {
  const client = createMockCloudClient();
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
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
      cwd: () => "/tmp",
    },
  };
}

Deno.test("project create adds a project", async () => {
  const { client, d } = deps();
  const cmds = makeProjectCommands(d);
  const code = await cmds["cloud project create"]({
    args: ["myapp"],
    flags: { json: true, yes: true, noInput: true },
    raw: {},
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
  await cmds["cloud project use"]({
    args: [p.id],
    flags: { json: true, yes: true, noInput: true },
    raw: {},
  });
  assertEquals(config.currentProject, p.id);
});
