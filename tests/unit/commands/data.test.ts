import { assertEquals } from "@std/assert";
import { makeDataCommands } from "../../../src/commands/data.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import { join } from "@std/path";

Deno.test("data export writes response body to out file", async () => {
  const dir = await Deno.makeTempDir();
  const out = join(dir, "export.zip");
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  client.ext = (path, body) => {
    client.calls.ext.push([path, body]);
    return Promise.resolve(new Response("ZIPDATA", { status: 200 }));
  };
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeDataCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => dir,
  });
  const code = await cmds["cloud data export"]({
    args: [],
    flags: { json: true, yes: true, noInput: true, project: p.id },
    raw: { out },
  });
  assertEquals(code, 0);
  assertEquals(await Deno.readTextFile(out), "ZIPDATA");
  assertEquals(client.calls.ext[0][0], "/api/projects/export");
});
