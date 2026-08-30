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
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makePbCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
  });
  const code = await cmds["pocketbase hooks push"].run(
    { name: "db1" },
    {
      args: [dir],
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
  const [path, body] = client.calls.pbApi[0];
  assertEquals(path, "/api/hooks/bulk-write");
  assertEquals((body as { pocketbase_id: string }).pocketbase_id, pb.id);
  const hook = (body as { hooks: { filename: string; active: boolean }[] })
    .hooks[0];
  assertEquals(hook.filename, "main.pb.js");
  assertEquals(hook.active, true);
});
