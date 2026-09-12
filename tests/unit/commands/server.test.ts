import { assertStringIncludes } from "@std/assert";
import { makeServerCommands } from "../../../src/commands/server.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";

function deps() {
  const client = createMockCloudClient();
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  return {
    client,
    d: {
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: (c: Config) => {
        Object.assign(config, c);
        return Promise.resolve();
      },
      cwd: () => "/tmp",
    },
  };
}

function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  return fn().then(
    () => {
      console.log = original;
      return lines.join("\n");
    },
    (e) => {
      console.log = original;
      throw e;
    },
  );
}

Deno.test("compute ls shows the shortKey to distinguish compute in the same location", async () => {
  const { client, d } = deps();
  client.servers.push(
    {
      id: "s1",
      name: "one",
      status: "running",
      location: "GRA",
      ownership: "user",
      shortKey: "ab12",
    },
    {
      id: "s2",
      name: "two",
      status: "running",
      location: "GRA",
      ownership: "user",
      shortKey: "cd34",
    },
  );
  const cmds = makeServerCommands(d);
  const out = await captureLog(() =>
    cmds["compute ls"].run({}, {
      args: [],
      flags: { json: false, yes: true, noInput: true, interactive: false },
    })
  );
  assertStringIncludes(out, "Compute 1 — Gravelines (ab12)");
  assertStringIncludes(out, "Compute 2 — Gravelines (cd34)");
});
