import { assertEquals, assertStringIncludes } from "@std/assert";
import { makeUpgradeCommands } from "../../../src/commands/upgrade.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";

Deno.test("upgrade prints plan and portal link", async () => {
  const client = createMockCloudClient();
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  let printed = "";
  const cmds = makeUpgradeCommands(
    {
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => "/tmp",
    },
    "https://app.pocketbase.cloud",
    (s) => printed += s + "\n",
  );
  const code = await cmds["plan"].run({}, {
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
  assertStringIncludes(printed, "pro");
  assertStringIncludes(printed, "https://app.pocketbase.cloud/plan");
});
