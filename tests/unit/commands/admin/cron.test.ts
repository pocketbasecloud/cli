import { assertEquals } from "@std/assert";
import { makeCronCommands } from "../../../../src/commands/admin/cron.ts";
import { createMockAdminClient } from "../../../mocks/admin.mock.ts";
import type { AdminCmdDeps } from "../../../../src/commands/admin/deps.ts";

function deps(client = createMockAdminClient()): AdminCmdDeps {
  return {
    requireAdmin: () =>
      Promise.resolve({
        client,
        profile: { url: "u", superuserToken: "t" },
        name: "p",
      }),
    loadConfig: () => Promise.reject(new Error("unused")),
    saveConfig: () => Promise.resolve(),
    makeClient: () => client,
  };
}

Deno.test("cron run passes job id", async () => {
  const client = createMockAdminClient();
  const cmds = makeCronCommands(deps(client));
  const code = await cmds["cron run"]({
    args: ["__pbLogsCleanup__"],
    flags: { json: true, yes: true, noInput: true, interactive: false },
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(client.calls.runCron[0], ["__pbLogsCleanup__"]);
});
