import { assertEquals } from "@std/assert";
import { makeInstanceLogsCommands } from "../../../../src/commands/admin/logs.ts";
import { createMockAdminClient } from "../../../mocks/admin.mock.ts";
import type { AdminCmdDeps } from "../../../../src/commands/admin/deps.ts";
import type { AdminRecord } from "../../../../src/clients/admin-types.ts";

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
  const code = await cmds["admin requests"].run(
    { filter: "level>0" },
    {
      args: [],
      flags: { json: true, yes: true, noInput: true, interactive: false },
    },
  );
  assertEquals(code, 0);
  assertEquals(seenFilter, "level>0");
});

Deno.test("logs --json emits one envelope per record", async () => {
  const client = createMockAdminClient();
  client.listLogs = () =>
    Promise.resolve({
      items: [
        { id: "1", created: "t1", level: 0, message: "a" },
        { id: "2", created: "t2", level: 1, message: "b" },
      ] as AdminRecord[],
      page: 1,
      perPage: 50,
      totalItems: 2,
      totalPages: 1,
    });
  const cmds = makeInstanceLogsCommands(deps(client));
  const lines: string[] = [];
  const original = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    const code = await cmds["admin requests"].run(
      {},
      {
        args: [],
        flags: { json: true, yes: true, noInput: true, interactive: false },
      },
    );
    assertEquals(code, 0);
  } finally {
    console.log = original;
  }
  assertEquals(lines.length, 2);
  for (const l of lines) {
    const parsed = JSON.parse(l);
    assertEquals(parsed.ok, true);
    assertEquals(parsed.schemaVersion, 1);
    assertEquals(typeof parsed.data.id, "string");
  }
});
