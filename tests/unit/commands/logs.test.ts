import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  makeLogsCommands,
  reportDeploymentLogs,
  streamToWriter,
} from "../../../src/commands/logs.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";

function sse(...frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f));
      c.close();
    },
  });
}

Deno.test("streamToWriter unwraps SSE data frames", async () => {
  let out = "";
  await streamToWriter(
    sse(
      'data: {"line":"line1"}\n\n',
      'data: {"message":"line2"}\n\n',
    ),
    (s) => out += s,
  );
  assertStringIncludes(out, "line1");
  assertStringIncludes(out, "line2");
  assertEquals(out.includes("data:"), false);
});

Deno.test("streamToWriter passes plain text through and labels errors", async () => {
  let out = "";
  await streamToWriter(
    sse("not json\n", 'data: {"type":"error","message":"boom"}\n'),
    (s) => out += s,
  );
  assertEquals(out, "not json\nError: boom\n");
});

Deno.test("streamToWriter stops at the limit, since the tail never ends", async () => {
  let out = "";
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 100; i++) {
        c.enqueue(new TextEncoder().encode(`data: {"line":"L${i}"}\n`));
      }
    },
  });
  await streamToWriter(stream, (s) => out += s, { limit: 3 });
  assertEquals(out, "L0\nL1\nL2\n");
});

Deno.test("logs posts to logs/stream with type and id", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pbRes = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  client.ext = (path, body) => {
    client.calls.ext.push([path, body]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("log\n"));
        c.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeLogsCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
  });
  const code = await cmds["logs"].run(
    { name: "db1" },
    {
      args: ["pb"],
      flags: {
        json: false,
        yes: true,
        noInput: true,
        interactive: false,
        project: p.id,
      },
    },
  );
  assertEquals(code, 0);
  assertEquals(client.calls.ext[0][0], "/api/logs/stream");
  assertEquals(
    (client.calls.ext[0][1] as { target_id: string }).target_id,
    pbRes.id,
  );
});

Deno.test("logs --json emits one envelope per line", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db1", project: p.id });
  client.ext = () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("line one\nline two\n"));
        c.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeLogsCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
  });
  const chunks: string[] = [];
  const original = Deno.stdout.writeSync.bind(Deno.stdout);
  const dec = new TextDecoder();
  Deno.stdout.writeSync = (b: Uint8Array) => {
    chunks.push(dec.decode(b));
    return b.byteLength;
  };
  try {
    const code = await cmds["logs"].run(
      { name: "db1" },
      {
        args: ["pb"],
        flags: { json: true, yes: true, noInput: true, interactive: false },
      },
    );
    assertEquals(code, 0);
  } finally {
    Deno.stdout.writeSync = original;
  }
  const text = chunks.join("");
  const lines = text.trim().split("\n");
  assertEquals(lines.length, 2);
  for (const l of lines) {
    const parsed = JSON.parse(l);
    assertEquals(parsed.ok, true);
    assertEquals(parsed.schemaVersion, 1);
    assertEquals(typeof parsed.data.line, "string");
  }
  assertEquals(JSON.parse(lines[0]).data.line, "line one");
  assertEquals(JSON.parse(lines[1]).data.line, "line two");
});

Deno.test("logs --env streams that environment's instance", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const prod = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
  });
  const staging = await client.createResource("pocketbases", {
    name: "db1-staging",
    project: p.id,
  });
  client.ext = (path, body) => {
    client.calls.ext.push([path, body]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  const cwd = Deno.makeTempDirSync();
  await Deno.writeTextFile(
    `${cwd}/pbc.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: {
        production: { id: prod.id, name: "db1" },
        staging: { id: staging.id, name: "db1-staging" },
      },
    }),
  );
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeLogsCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
  });
  const flags = {
    json: false,
    yes: true,
    noInput: true,
    interactive: false,
    project: p.id,
  };
  await cmds["logs"].run(
    { env: "staging" },
    { args: ["pb"], flags },
  );
  assertEquals(
    (client.calls.ext[0][1] as { target_id: string }).target_id,
    staging.id,
  );
  await cmds["logs"].run({}, { args: ["pb"], flags });
  assertEquals(
    (client.calls.ext[1][1] as { target_id: string }).target_id,
    prod.id,
  );
  await Deno.remove(cwd, { recursive: true });
});

function captureLog() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) =>
    lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.error = original };
}

Deno.test("logs resolves a named instance across projects, no project step", async () => {
  const client = createMockCloudClient();
  await client.createProject("app");
  const other = await client.createProject("other");
  await client.createResource("pocketbases", { name: "db1", project: other.id });
  const seen: string[] = [];
  client.ext = (_path, body) => {
    seen.push(String((body as { target_id?: string }).target_id));
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        { status: 200 },
      ),
    );
  };
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  const cmds = makeLogsCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
  });
  const log = captureLog();
  try {
    const code = await cmds["logs"].run(
      { name: "db1" },
      {
        args: ["pb"],
        flags: { json: false, yes: true, noInput: true, interactive: false },
      },
    );
    assertEquals(code, 0);
    const db1 = (await client.listResources("pocketbases"))[0];
    assertEquals(seen, [db1.id]);
    assertEquals(log.lines.some((l) => l.startsWith("Project:")), false);
  } finally {
    log.restore();
  }
});

Deno.test("logs does not announce the project when --project names it", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db1", project: p.id });
  client.ext = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        { status: 200 },
      ),
    );
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  const cmds = makeLogsCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
  });
  const log = captureLog();
  try {
    await cmds["logs"].run(
      { name: "db1" },
      {
        args: ["pb"],
        flags: {
          json: false,
          yes: true,
          noInput: true,
          interactive: false,
          project: p.id,
        },
      },
    );
    assertEquals(log.lines.some((l) => l.startsWith("Project:")), false);
  } finally {
    log.restore();
  }
});

Deno.test("deployment logs cancel a quiet stream after the deadline", async () => {
  let cancelled = false;
  const client = createMockCloudClient({
    ext: () => Promise.resolve(new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }))),
  });
  const lines: string[] = [];
  await reportDeploymentLogs(client, {
    type: "pocketbase",
    targetId: "db1",
    log: (line) => lines.push(line),
    timeoutMs: 1,
  });
  assertEquals(cancelled, true);
  assertStringIncludes(lines.join("\n"), "No logs available yet.");
  assertStringIncludes(lines.join("\n"), "pbc logs pocketbase --id db1 --follow");
});

Deno.test("deployment logs limit history and cancel the tail", async () => {
  let cancelled = false;
  const client = createMockCloudClient({
    ext: () => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 60; i++) {
          controller.enqueue(new TextEncoder().encode(`data: {"line":"Log ${i}"}\n\n`));
        }
      },
      cancel() { cancelled = true; },
    }))),
  });
  const lines: string[] = [];
  await reportDeploymentLogs(client, {
    type: "backend",
    targetId: "api1",
    log: (line) => lines.push(line),
  });
  assertEquals(lines.filter((line) => line.startsWith("Log ")).length, 50);
  assertEquals(cancelled, true);
});

Deno.test("deployment logs preserve partial output when the tail stays open", async () => {
  const client = createMockCloudClient({
    ext: () => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"line":"Started"}\n\n'));
      },
    }))),
  });
  const lines: string[] = [];
  await reportDeploymentLogs(client, {
    type: "backend",
    targetId: "api1",
    log: (line) => lines.push(line),
    timeoutMs: 1,
  });
  assertEquals(lines, [
    "Recent logs (50 lines max):",
    "Started",
    "Follow logs: pbc logs backend --id api1 --follow",
  ]);
});

Deno.test("deployment logs abort a stalled connection", async () => {
  const client = createMockCloudClient({
    ext: (_path, _body, opts) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
    }),
  });
  const lines: string[] = [];
  await reportDeploymentLogs(client, {
    type: "backend",
    targetId: "api1",
    log: (line) => lines.push(line),
    timeoutMs: 1,
  });
  assertStringIncludes(lines.join("\n"), "No logs available yet.");
});

Deno.test("deployment log failures report a warning without failing the deploy", async () => {
  const client = createMockCloudClient({
    ext: () => Promise.resolve(new Response("Logs unavailable", { status: 503 })),
  });
  const lines: string[] = [];
  await reportDeploymentLogs(client, {
    type: "backend",
    targetId: "api1",
    log: (line) => lines.push(line),
  });
  assertStringIncludes(lines.join("\n"), "Could not read logs:");
  assertStringIncludes(lines.join("\n"), "pbc logs backend --id api1 --follow");
});
