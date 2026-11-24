import { assertEquals, assertRejects } from "@std/assert";
import { makeSelfDrivingCommands } from "../../../src/commands/self-driving.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { defaultConfig } from "../../../src/config.ts";
import { CliError } from "../../../src/errors.ts";

Deno.test("enabling self-driving from a CLI login opens the portal's switch", async () => {
  const opened: string[] = [];
  const client = createMockCloudClient({
    ext: () =>
      Promise.resolve(
        Response.json({
          success: false,
          error: "session",
          message: "portal only",
        }, { status: 403 }),
      ),
  });
  const cmds = makeSelfDrivingCommands({
    requireAuth: () =>
      Promise.resolve({
        client,
        config: defaultConfig(),
        auth: {
          backendUrl: "u",
          extUrl: "x",
          userToken: "pbc_d_t",
          userId: "u1",
        },
      }),
    loadConfig: () => Promise.resolve(defaultConfig()),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/",
    portalBase: "https://portal.test",
    openUrl: (url) => opened.push(url),
  });
  const error = await assertRejects(
    () =>
      cmds["self-driving enable"].run({}, {
        args: [],
        flags: { json: true, yes: true, noInput: true, interactive: false },
      }),
    CliError,
  );
  assertEquals(opened, ["https://portal.test/account#self-driving"]);
  assertEquals(
    error.message.includes("https://portal.test/account#self-driving"),
    true,
  );
});
