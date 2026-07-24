import { assertEquals } from "@std/assert";
import { makeRecordsCommands } from "../../../../src/commands/admin/records.ts";
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

Deno.test("records create parses JSON data and posts", async () => {
  const client = createMockAdminClient();
  const cmds = makeRecordsCommands(deps(client));
  const code = await cmds["records create"]({
    args: ["posts", '{"title":"hi"}'],
    flags: { json: true, yes: true, noInput: true, interactive: false },
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createRecord[0][0], "posts");
  assertEquals(client.calls.createRecord[0][1], { title: "hi" });
});

Deno.test("records rm requires collection and id", async () => {
  const client = createMockAdminClient();
  const cmds = makeRecordsCommands(deps(client));
  const code = await cmds["records rm"]({
    args: ["posts", "rec1"],
    flags: { json: true, yes: true, noInput: true, interactive: false },
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(client.calls.deleteRecord[0], ["posts", "rec1"]);
});
