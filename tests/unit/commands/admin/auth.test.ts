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
  const code = await cmds["admin use"].run({}, {
    args: ["https://db.example.com"],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
  assertEquals(config.defaultProfile, "https://db.example.com");
  assertEquals(
    config.profiles["https://db.example.com"].url,
    "https://db.example.com",
  );
});

Deno.test("login stores the returned token", async () => {
  const config: Config = {
    ...defaultConfig(),
    defaultProfile: "p",
    profiles: { p: { url: "https://db.example.com", superuserToken: "" } },
  };
  const cmds = makeInstanceAuthCommands(deps(config).d);
  const code = await cmds["admin login"].run(
    { email: "a@b.co", password: "secret" },
    {
      args: [],
      flags: { json: true, yes: true, noInput: true, interactive: false },
    },
  );
  assertEquals(code, 0);
  assertEquals(config.profiles["p"].superuserToken, "mock-superuser-token");
});

Deno.test("login --url creates a profile, stores the account, and selects it", async () => {
  const config = defaultConfig();
  const cmds = makeInstanceAuthCommands(deps(config).d);
  const code = await cmds["admin login"].run(
    { email: "a@b.co", password: "secret", url: "https://db.example.com" },
    {
      args: [],
      flags: { json: true, yes: true, noInput: true, interactive: false },
    },
  );
  assertEquals(code, 0);
  assertEquals(config.defaultProfile, "https://db.example.com");
  assertEquals(config.profiles["https://db.example.com"], {
    url: "https://db.example.com",
    superuserToken: "mock-superuser-token",
    email: "a@b.co",
  });
});

Deno.test("login --url --name adds a second admin on the same instance", async () => {
  const config: Config = {
    ...defaultConfig(),
    defaultProfile: "personal",
    profiles: {
      personal: { url: "https://db.example.com", superuserToken: "t" },
    },
  };
  const cmds = makeInstanceAuthCommands(deps(config).d);
  const code = await cmds["admin login"].run(
    {
      email: "work@b.co",
      password: "secret",
      url: "https://db.example.com",
      name: "work",
    },
    {
      args: [],
      flags: { json: true, yes: true, noInput: true, interactive: false },
    },
  );
  assertEquals(code, 0);
  assertEquals(config.defaultProfile, "personal");
  assertEquals(config.profiles.work.email, "work@b.co");
  assertEquals(config.profiles.work.superuserToken, "mock-superuser-token");
});

Deno.test("use --name switches to a saved profile without a url", async () => {
  const config: Config = {
    ...defaultConfig(),
    defaultProfile: "personal",
    profiles: {
      personal: { url: "https://a.example.com", superuserToken: "t" },
      work: { url: "https://b.example.com", superuserToken: "t" },
    },
  };
  const cmds = makeInstanceAuthCommands(deps(config).d);
  const code = await cmds["admin use"].run({ name: "work" }, {
    args: [],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
  assertEquals(config.defaultProfile, "work");
});

Deno.test("profiles lists saved profiles with the active marked", async () => {
  const config: Config = {
    ...defaultConfig(),
    defaultProfile: "work",
    profiles: {
      work: {
        url: "https://b.example.com",
        superuserToken: "t",
        email: "w@b.co",
      },
      personal: { url: "https://a.example.com", superuserToken: "" },
    },
  };
  const cmds = makeInstanceAuthCommands(deps(config).d);
  const lines: string[] = [];
  const original = console.log;
  console.log = (s: string) => {
    lines.push(s);
  };
  try {
    const code = await cmds["admin profiles"].run({}, {
      args: [],
      flags: { json: true, yes: true, noInput: true, interactive: false },
    });
    assertEquals(code, 0);
  } finally {
    console.log = original;
  }
  const data = JSON.parse(lines[0]).data as {
    name: string;
    active: boolean;
    authenticated: boolean;
    email: string;
  }[];
  assertEquals(data.map((p) => p.name), ["personal", "work"]);
  assertEquals(data.find((p) => p.name === "work")?.active, true);
  assertEquals(data.find((p) => p.name === "personal")?.authenticated, false);
  assertEquals(
    data.find((p) => p.name === "work")?.email,
    "w@b.co",
  );
});

Deno.test("whoami survives a profile with no superuserToken key", async () => {
  const config: Config = {
    ...defaultConfig(),
    defaultProfile: "p",
    profiles: { p: { url: "https://db.example.com", superuserToken: "" } },
  };
  delete (config.profiles.p as Record<string, unknown>).superuserToken;
  const cmds = makeInstanceAuthCommands(deps(config).d);
  const code = await cmds["admin whoami"].run({}, {
    args: [],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
});
