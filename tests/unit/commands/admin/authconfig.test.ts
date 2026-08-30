import { assertEquals, assertRejects } from "@std/assert";
import { makeAuthConfigCommands } from "../../../../src/commands/admin/authconfig.ts";
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

Deno.test("auth config --set updates a field on an auth collection", async () => {
  const client = createMockAdminClient();
  await client.createCollection({ name: "users", type: "auth" });
  const cmds = makeAuthConfigCommands(deps(client));
  const code = await cmds["admin auth"].run(
    { set: 'oauth2={"enabled":true}' },
    {
      args: ["users", "config"],
      flags: { json: true, yes: true, noInput: true, interactive: false },
    },
  );
  assertEquals(code, 0);
  const [, data] = client.calls.updateCollection[0];
  assertEquals(data.oauth2, { enabled: true });
});

Deno.test("auth config rejects non-auth collections", async () => {
  const client = createMockAdminClient();
  await client.createCollection({ name: "posts", type: "base" });
  const cmds = makeAuthConfigCommands(deps(client));
  await assertRejects(
    () =>
      cmds["admin auth"].run({}, {
        args: ["posts", "config"],
        flags: { json: true, yes: true, noInput: true, interactive: false },
      }),
    Error,
    "not an auth collection",
  );
});
