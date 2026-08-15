import { assertEquals } from "@std/assert";
import { makeRecordsCommands } from "../../../../src/commands/admin/records.ts";
import { makeCollectionsCommands } from "../../../../src/commands/admin/collections.ts";
import { makeSettingsCommands } from "../../../../src/commands/admin/settings.ts";
import { createMockAdminClient } from "../../../mocks/admin.mock.ts";
import type { MockAdminClient } from "../../../mocks/admin.mock.ts";
import type { AdminCmdDeps } from "../../../../src/commands/admin/deps.ts";

function deps(client: MockAdminClient): AdminCmdDeps {
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

const flags = {
  json: true,
  yes: true,
  noInput: true,
  interactive: false,
} as const;

Deno.test("records update takes no write lock when the record already matches", async () => {
  const client = createMockAdminClient();
  const created = await client.createRecord("posts", { title: "hi" });
  const cmds = makeRecordsCommands(deps(client));

  const code = await cmds["records update"]({
    args: ["posts", created.id, '{"title":"hi"}'],
    flags,
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(client.calls.updateRecord.length, 0);
});

Deno.test("records update still writes when any field differs", async () => {
  const client = createMockAdminClient();
  const created = await client.createRecord("posts", {
    title: "hi",
    body: "same",
  });
  const cmds = makeRecordsCommands(deps(client));

  const code = await cmds["records update"]({
    args: ["posts", created.id, '{"title":"hi","body":"changed"}'],
    flags,
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(client.calls.updateRecord.length, 1);
  assertEquals(client.calls.updateRecord[0][2], {
    title: "hi",
    body: "changed",
  });
});

Deno.test("records update --force writes an identical body anyway", async () => {
  const client = createMockAdminClient();
  const created = await client.createRecord("posts", { title: "hi" });
  const cmds = makeRecordsCommands(deps(client));

  const code = await cmds["records update"]({
    args: ["posts", created.id, '{"title":"hi"}'],
    flags,
    raw: { force: true },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.updateRecord.length, 1);
});

Deno.test("collections update skips a definition the instance already holds", async () => {
  const client = createMockAdminClient();
  await client.createCollection({ name: "posts", type: "base" });
  const cmds = makeCollectionsCommands(deps(client));

  const unchanged = await cmds["collections update"]({
    args: ["posts", '{"type":"base"}'],
    flags,
    raw: {},
  });
  assertEquals(unchanged, 0);
  assertEquals(client.calls.updateCollection.length, 0);

  // A real change still rebuilds the collection.
  const changed = await cmds["collections update"]({
    args: ["posts", '{"listRule":"@request.auth.id != \\"\\""}'],
    flags,
    raw: {},
  });
  assertEquals(changed, 0);
  assertEquals(client.calls.updateCollection.length, 1);
});

Deno.test("settings set skips a section that already matches", async () => {
  const client = createMockAdminClient();
  const cmds = makeSettingsCommands(deps(client));

  // The mock starts with { s3: { enabled: false } }.
  const same = await cmds["settings s3 set"]({
    args: ['{"enabled":false}'],
    flags,
    raw: {},
  });
  assertEquals(same, 0);
  assertEquals(client.calls.updateSettings.length, 0);

  const different = await cmds["settings s3 set"]({
    args: ['{"enabled":true,"bucket":"b"}'],
    flags,
    raw: {},
  });
  assertEquals(different, 0);
  assertEquals(client.calls.updateSettings.length, 1);

  // And once written, re-sending the same block is a no-op again.
  const repeat = await cmds["settings s3 set"]({
    args: ['{"enabled":true,"bucket":"b"}'],
    flags,
    raw: {},
  });
  assertEquals(repeat, 0);
  assertEquals(client.calls.updateSettings.length, 1);
});

Deno.test("settings mail set --force writes regardless", async () => {
  const client = createMockAdminClient();
  const cmds = makeSettingsCommands(deps(client));

  const code = await cmds["settings mail set"]({
    args: ['{"enabled":false}'],
    flags,
    raw: { force: true },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.updateSettings.length, 1);
});
