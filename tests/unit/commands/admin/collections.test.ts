import { assertEquals } from "@std/assert";
import { makeCollectionsCommands } from "../../../../src/commands/admin/collections.ts";
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

Deno.test("collections create sends name and type", async () => {
  const client = createMockAdminClient();
  const cmds = makeCollectionsCommands(deps(client));
  const code = await cmds["collections create"]({
    args: ["posts"],
    flags: { json: true, yes: true, noInput: true },
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(
    (await client.listCollections()).some((c) => c.name === "posts"),
    true,
  );
});

Deno.test("collections export writes JSON to out file", async () => {
  const dir = await Deno.makeTempDir();
  const out = `${dir}/schema.json`;
  const client = createMockAdminClient();
  await client.createCollection({ name: "posts" });
  const cmds = makeCollectionsCommands(deps(client));
  const code = await cmds["collections export"]({
    args: [],
    flags: { json: true, yes: true, noInput: true },
    raw: { out },
  });
  assertEquals(code, 0);
  const parsed = JSON.parse(await Deno.readTextFile(out));
  assertEquals(Array.isArray(parsed), true);
  assertEquals(parsed.length, 1);
});
