import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  makeLogsCommands,
  streamToWriter,
} from "../../../src/commands/logs.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";

Deno.test("streamToWriter forwards decoded chunks", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("line1\n"));
      c.enqueue(new TextEncoder().encode("line2\n"));
      c.close();
    },
  });
  let out = "";
  await streamToWriter(stream, (s) => out += s);
  assertStringIncludes(out, "line1");
  assertStringIncludes(out, "line2");
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
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeLogsCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
  });
  const code = await cmds["cloud logs"]({
    args: ["pb"],
    flags: {
      json: false,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
    raw: { name: "db1" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.ext[0][0], "/api/logs/stream");
  assertEquals(
    (client.calls.ext[0][1] as { targetId: string }).targetId,
    pbRes.id,
  );
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
    `${cwd}/pb.json`,
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
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
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
  await cmds["cloud logs"]({ args: ["pb"], flags, raw: { env: "staging" } });
  assertEquals(
    (client.calls.ext[0][1] as { targetId: string }).targetId,
    staging.id,
  );
  // And with no --env, the file's default.
  await cmds["cloud logs"]({ args: ["pb"], flags, raw: {} });
  assertEquals(
    (client.calls.ext[1][1] as { targetId: string }).targetId,
    prod.id,
  );
  await Deno.remove(cwd, { recursive: true });
});
