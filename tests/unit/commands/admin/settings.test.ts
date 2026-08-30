import { assertEquals } from "@std/assert";
import { makeSettingsCommands } from "../../../../src/commands/admin/settings.ts";
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

Deno.test("settings mail set updates smtp section", async () => {
  const client = createMockAdminClient();
  const cmds = makeSettingsCommands(deps(client));
  const code = await cmds["admin settings mail set"].run({}, {
    args: ['{"enabled":true,"host":"smtp.example.com"}'],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
  const [data] = client.calls.updateSettings[0];
  assertEquals((data.smtp as Record<string, unknown>).host, "smtp.example.com");
});

Deno.test("settings backup create passes basename", async () => {
  const client = createMockAdminClient();
  const cmds = makeSettingsCommands(deps(client));
  const code = await cmds["admin settings backup create"].run({}, {
    args: ["snapshot.zip"],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createBackup[0], ["snapshot.zip"]);
});
