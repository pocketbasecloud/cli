import { assertEquals } from "@std/assert";
import { makePbCommands } from "../../../src/commands/pb.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import { join } from "@std/path";

Deno.test("hooks push reads dir and calls bulk-write", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "main.pb.js"), "routerAdd()");
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makePbCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
  });
  const code = await cmds["cloud pb hooks push"]({
    args: [dir],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(client.calls.ext[0][0], "/api/hooks/bulk-write");
});
