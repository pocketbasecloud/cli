import { assertEquals } from "@std/assert";
import { makeInstanceLogsCommands } from "../../../../src/commands/admin/logs.ts";
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

Deno.test("logs one-shot returns 0 and forwards filter", async () => {
  const client = createMockAdminClient();
  let seenFilter: string | undefined;
  client.listLogs = (opts) => {
    seenFilter = opts.filter;
    return Promise.resolve({
      items: [],
      page: 1,
      perPage: 50,
      totalItems: 0,
      totalPages: 0,
    });
  };
  const cmds = makeInstanceLogsCommands(deps(client));
  const code = await cmds["logs"]({
    args: [],
    flags: { json: true, yes: true, noInput: true, interactive: false },
    raw: { filter: "level>0" },
  });
  assertEquals(code, 0);
  assertEquals(seenFilter, "level>0");
});
