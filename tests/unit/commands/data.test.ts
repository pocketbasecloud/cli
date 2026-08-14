import { assertEquals, assertRejects } from "@std/assert";
import {
  makeDataCommands,
  normalizeDownloadUrl,
} from "../../../src/commands/data.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import { join } from "@std/path";

Deno.test("normalizeDownloadUrl repairs the platform's single slash", () => {
  assertEquals(
    normalizeDownloadUrl(
      "https:/backend.example.com/api/files/exports/a/b.zip",
    ),
    "https://backend.example.com/api/files/exports/a/b.zip",
  );
  // An already-correct URL is left alone.
  assertEquals(
    normalizeDownloadUrl("https://backend.example.com/x.zip"),
    "https://backend.example.com/x.zip",
  );
});

function setup(
  client: ReturnType<typeof createMockCloudClient>,
  currentProject = "",
) {
  const dir = Deno.makeTempDirSync();
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject,
  };
  return {
    dir,
    cmds: makeDataCommands({
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: () => Promise.resolve(),
      cwd: () => dir,
    }),
  };
}

const flags = (project: string) => ({
  json: true,
  yes: true,
  noInput: true,
  interactive: false,
  project,
});

Deno.test("data export downloads the file the platform points at", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  // The route answers with JSON; the archive lives behind downloadUrl.
  client.ext = (path, body) => {
    client.calls.ext.push([path, body]);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          success: true,
          downloadUrl: "https:/files.example.com/api/files/exports/e1/db.zip",
          fileName: "db.zip",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (input: string | URL | Request) => {
    requested = String(input);
    return Promise.resolve(new Response("ZIPDATA", { status: 200 }));
  };
  try {
    const { dir, cmds } = setup(client);
    const out = join(dir, "export.zip");
    const code = await cmds["cloud data export"]({
      args: [],
      flags: flags(p.id),
      raw: { out, name: "db1" },
    });
    assertEquals(code, 0);
    assertEquals(await Deno.readTextFile(out), "ZIPDATA");
    assertEquals(client.calls.ext[0][0], "/api/projects/export");
    // The instance id, not the project id — the route just names it projectId.
    assertEquals(
      (client.calls.ext[0][1] as { projectId: string }).projectId,
      pb.id,
    );
    // Scheme repaired, and the file token appended.
    assertEquals(
      requested,
      "https://files.example.com/api/files/exports/e1/db.zip?token=filetoken",
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("data export reports the platform's reason for failing", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db1", project: p.id });
  client.ext = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ success: false, error: "No collections to export" }),
        { status: 500 },
      ),
    );
  const { cmds } = setup(client);
  await assertRejects(
    () =>
      cmds["cloud data export"]({
        args: [],
        flags: flags(p.id),
        raw: { name: "db1" },
      }),
    Error,
    "Export failed (500): No collections to export.",
  );
});

function captureLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.log = original };
}

Deno.test("data export announces the project resolved from config.currentProject", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db1", project: p.id });
  client.ext = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ success: false, error: "No collections to export" }),
        { status: 500 },
      ),
    );
  const { cmds } = setup(client, p.id);
  const log = captureLog();
  try {
    await assertRejects(() =>
      cmds["cloud data export"]({
        args: [],
        flags: { json: false, yes: true, noInput: true, interactive: false },
        raw: { name: "db1" },
      })
    );
    assertEquals(log.lines[0].includes(`Project: ${p.name}`), true);
    assertEquals(log.lines[0].includes("pb cloud project use"), true);
  } finally {
    log.restore();
  }
});

Deno.test("data export does not announce the project when --project names it", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db1", project: p.id });
  client.ext = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ success: false, error: "No collections to export" }),
        { status: 500 },
      ),
    );
  const { cmds } = setup(client);
  const log = captureLog();
  try {
    await assertRejects(() =>
      cmds["cloud data export"]({
        args: [],
        flags: {
          json: false,
          yes: true,
          noInput: true,
          interactive: false,
          project: p.id,
        },
        raw: { name: "db1" },
      })
    );
    assertEquals(log.lines.some((l) => l.startsWith("Project:")), false);
  } finally {
    log.restore();
  }
});

Deno.test("data import says what it needs instead of sending a doomed request", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const { cmds } = setup(client);
  await assertRejects(
    () =>
      cmds["cloud data import"]({
        args: ["rows.csv"],
        flags: flags(p.id),
        raw: {},
      }),
    Error,
    "needs a target collection and a field mapping",
  );
  assertEquals(client.calls.ext.length, 0);
});
