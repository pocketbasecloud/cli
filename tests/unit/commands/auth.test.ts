import { assertEquals } from "@std/assert";
import { makeAuthCommands } from "../../../src/commands/auth.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { defaultConfig } from "../../../src/config.ts";

Deno.test("whoami prints user when authenticated", async () => {
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", userToken: "t", userId: "u1" };
  const cmds = makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: (c) => {
      Object.assign(saved, c);
      return Promise.resolve();
    },
    makeClient: () => createMockCloudClient(),
    login: () => Promise.resolve(saved.cloud!),
    portalUrl: "https://portal",
    backendUrl: "https://backend",
  });
  const code = await cmds["cloud whoami"]({
    args: [],
    flags: { json: true, yes: false, noInput: true },
    raw: {},
  });
  assertEquals(code, 0);
});

Deno.test("logout clears cloud auth", async () => {
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", userToken: "t", userId: "u1" };
  const cmds = makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: (c) => {
      Object.assign(saved, c);
      return Promise.resolve();
    },
    makeClient: () => createMockCloudClient(),
    login: () => Promise.resolve(saved.cloud!),
    portalUrl: "https://portal",
    backendUrl: "https://backend",
  });
  await cmds["cloud logout"]({
    args: [],
    flags: { json: false, yes: true, noInput: true },
    raw: {},
  });
  assertEquals(saved.cloud, null);
});
