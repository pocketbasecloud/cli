import { assertEquals } from "@std/assert";
import { makePbCommands } from "../../../src/commands/pb.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";

function deps(
  client = createMockCloudClient(),
  currentProject = "",
): { d: CloudCmdDeps; config: Config } {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject,
  };
  return {
    config,
    d: {
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => "/tmp",
    },
  };
}

Deno.test("pb deploy creates then reaches running", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { d, config } = deps(client);
  config.currentProject = p.id;
  // Make getResource report running immediately.
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
  const cmds = makePbCommands(d);
  const code = await cmds["cloud pb deploy"]({
    args: [],
    flags: { json: true, yes: true, noInput: true, project: p.id },
    raw: { name: "db1" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 1);
});
