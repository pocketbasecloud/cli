import { assertEquals } from "@std/assert";
import {
  formatCell,
  makeRecordsCommands,
  renderRecordTable,
} from "../../../../src/commands/admin/records.ts";
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
  const code = await cmds["admin records create"].run({}, {
    args: ["posts", '{"title":"hi"}'],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createRecord[0][0], "posts");
  assertEquals(client.calls.createRecord[0][1], { title: "hi" });
});

Deno.test("records rm requires collection and id", async () => {
  const client = createMockAdminClient();
  const cmds = makeRecordsCommands(deps(client));
  const code = await cmds["admin records rm"].run({}, {
    args: ["posts", "rec1"],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.deleteRecord[0], ["posts", "rec1"]);
});

const METRICS = [
  {
    id: "rec1",
    collectionId: "c1",
    collectionName: "server_metrics",
    created: "2026-10-12 08:00:00.000Z",
    updated: "2026-10-12 08:00:00.000Z",
    cpu_percent: 12.5,
    server_id: "srv_a",
    service_failures: ["caddy"],
  },
];

Deno.test("records table shows values, hides system fields, puts timestamps last", () => {
  const lines = renderRecordTable(METRICS, { maxWidth: Infinity }).split("\n");
  assertEquals(
    lines[0].split(/\s+/),
    ["ID", "CPU_PERCENT", "SERVER_ID", "SERVICE_FAILURES", "CREATED", "UPDATED"],
  );
  assertEquals(lines[1].split(/\s{2,}/).slice(0, 4), [
    "rec1",
    "12.5",
    "srv_a",
    '["caddy"]',
  ]);
});

Deno.test("records table drops columns past the width and names them", () => {
  const out = renderRecordTable(METRICS, { maxWidth: 20 });
  assertEquals(out.split("\n")[0].split(/\s+/), ["ID", "CPU_PERCENT"]);
  assertEquals(
    out.includes(
      "4 more field(s) not shown: server_id, service_failures, created, updated.",
    ),
    true,
  );
});

Deno.test("records table --fields shows exactly the requested columns", () => {
  const out = renderRecordTable(METRICS, {
    fields: ["server_id", "missing"],
    maxWidth: 10,
  });
  assertEquals(out.split("\n")[0].split(/\s+/), ["ID", "SERVER_ID", "MISSING"]);
  assertEquals(out.includes("not shown"), false);
});

Deno.test("formatCell flattens whitespace and truncates long values", () => {
  assertEquals(formatCell(null), "");
  assertEquals(formatCell("a\nb"), "a b");
  assertEquals(formatCell("x".repeat(40)), `${"x".repeat(31)}…`);
});
