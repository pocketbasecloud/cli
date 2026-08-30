import { assertEquals } from "@std/assert";
import { makeRulesCommands } from "../../../../src/commands/admin/rules.ts";
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

Deno.test("rules set updates only provided rules and clears on 'null'", async () => {
  const client = createMockAdminClient();
  await client.createCollection({ name: "posts" });
  const cmds = makeRulesCommands(deps(client));
  const code = await cmds["admin rules set"].run(
    { listRule: "@request.auth.id != ''", deleteRule: "null" },
    {
      args: ["posts"],
      flags: { json: true, yes: true, noInput: true, interactive: false },
    },
  );
  assertEquals(code, 0);
  const [, data] = client.calls.updateCollection[0];
  assertEquals(data.listRule, "@request.auth.id != ''");
  assertEquals(data.deleteRule, null);
  assertEquals("viewRule" in data, false);
});
