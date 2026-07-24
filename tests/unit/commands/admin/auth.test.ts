import { assertEquals } from "@std/assert";
import { makeInstanceAuthCommands } from "../../../../src/commands/admin/auth.ts";
import { createMockAdminClient } from "../../../mocks/admin.mock.ts";
import { type Config, defaultConfig } from "../../../../src/config.ts";

function deps(config: Config) {
  const client = createMockAdminClient();
  return {
    client,
    d: {
      requireAdmin: () =>
        Promise.resolve({ client, profile: config.profiles["p"], name: "p" }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: (c: Config) => {
        Object.assign(config, c);
        return Promise.resolve();
      },
      makeClient: () => client,
    },
  };
}

Deno.test("use creates a profile and sets default", async () => {
  const config = defaultConfig();
  const cmds = makeInstanceAuthCommands(deps(config).d);
  const code = await cmds["use"]({
    args: ["https://db.example.com"],
    flags: { json: true, yes: true, noInput: true },
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(config.defaultProfile, "db.example.com");
  assertEquals(config.profiles["db.example.com"].url, "https://db.example.com");
});

Deno.test("login stores the returned token", async () => {
  const config: Config = {
    ...defaultConfig(),
    defaultProfile: "p",
    profiles: { p: { url: "https://db.example.com", superuserToken: "" } },
  };
  const cmds = makeInstanceAuthCommands(deps(config).d);
  const code = await cmds["login"]({
    args: [],
    flags: { json: true, yes: true, noInput: true },
    raw: { email: "a@b.co", password: "secret" },
  });
  assertEquals(code, 0);
  assertEquals(config.profiles["p"].superuserToken, "mock-superuser-token");
});
