import { assertEquals, assertStringIncludes } from "@std/assert";
import { makeAuthCommands } from "../../../src/commands/auth.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { defaultConfig } from "../../../src/config.ts";

Deno.test("whoami prints user when authenticated", async () => {
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" };
  const cmds = makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: (c) => {
      Object.assign(saved, c);
      return Promise.resolve();
    },
    makeClient: () => createMockCloudClient(),
    login: () => Promise.resolve(saved.cloud!),
    portalUrl: "https://portal",
  });
  const code = await cmds["whoami"].run({}, {
    args: [],
    flags: { json: true, yes: false, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
});

Deno.test("logout clears cloud auth and the selected project", async () => {
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" };
  saved.currentProject = "proj1";
  const cmds = makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: (c) => {
      Object.assign(saved, c);
      return Promise.resolve();
    },
    makeClient: () => createMockCloudClient(),
    login: () => Promise.resolve(saved.cloud!),
    portalUrl: "https://portal",
  });
  await cmds["logout"].run({}, {
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
  });
  assertEquals(saved.cloud, null);
  assertEquals(saved.currentProject, null);
});

function loginCmds(saved: ReturnType<typeof defaultConfig>, userId: string) {
  return makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: (c) => {
      Object.assign(saved, c);
      return Promise.resolve();
    },
    makeClient: () => createMockCloudClient(),
    login: () =>
      Promise.resolve({
        backendUrl: "u",
        extUrl: "x",
        userToken: "t2",
        userId,
      }),
    portalUrl: "https://portal",
  });
}

Deno.test("login as a different user clears the selected project", async () => {
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" };
  saved.currentProject = "proj1";
  await loginCmds(saved, "u2")["login"].run({}, {
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
  });
  assertEquals(saved.cloud?.userId, "u2");
  assertEquals(saved.currentProject, null);
});

Deno.test("login as the same user keeps the selected project", async () => {
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" };
  saved.currentProject = "proj1";
  await loginCmds(saved, "u1")["login"].run({}, {
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
  });
  assertEquals(saved.currentProject, "proj1");
});

Deno.test("login without a user id clears the selected project", async () => {
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", extUrl: "x", userToken: "t", userId: "" };
  saved.currentProject = "proj1";
  await loginCmds(saved, "")["login"].run({}, {
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
  });
  assertEquals(saved.currentProject, null);
});

Deno.test("login --token persists cloud auth resolved via whoami without opening the browser", async () => {
  const saved = defaultConfig();
  let browserLoginCalls = 0;
  const cmds = makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: (c) => {
      Object.assign(saved, c);
      return Promise.resolve();
    },
    makeClient: () =>
      createMockCloudClient({
        whoami: () =>
          Promise.resolve(
            {
              id: "u9",
              email: "u9@e.com",
              plan: "free",
              role: "member",
            } as never,
          ),
      }),
    login: () => {
      browserLoginCalls++;
      return Promise.reject(new Error("should not open the browser"));
    },
    portalUrl: "https://portal",
  });
  const code = await cmds["login"].run({ token: "tok123" }, {
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
  });
  assertEquals(code, 0);
  assertEquals(browserLoginCalls, 0);
  assertEquals(saved.cloud?.userToken, "tok123");
  assertEquals(saved.cloud?.userId, "u9");
});

Deno.test("login --token surfaces an invalid token without saving anything", async () => {
  const saved = defaultConfig();
  const cmds = makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: () => {
      throw new Error("should not save on a failed token login");
    },
    makeClient: () =>
      createMockCloudClient({
        whoami: () => Promise.reject(new Error("invalid token")),
      }),
    login: () => Promise.reject(new Error("should not open the browser")),
    portalUrl: "https://portal",
  });
  let threw = false;
  try {
    await cmds["login"].run({ token: "bad" }, {
      args: [],
      flags: { json: false, yes: true, noInput: true, interactive: false },
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(saved.cloud, null);
});

async function withStderr(fn: () => Promise<unknown>): Promise<string> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

Deno.test("login warns that PBC_TOKEN will override the saved login", async () => {
  const saved = defaultConfig();
  Deno.env.set("PBC_TOKEN", "envtok");
  try {
    const err = await withStderr(() =>
      loginCmds(saved, "u1")["login"].run({}, {
        args: [],
        flags: { json: false, yes: true, noInput: true, interactive: false },
      })
    );
    assertStringIncludes(err, "PBC_TOKEN");
  } finally {
    Deno.env.delete("PBC_TOKEN");
  }
});

Deno.test("logout warns that PBC_TOKEN still authenticates", async () => {
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" };
  const cmds = makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: (c) => {
      Object.assign(saved, c);
      return Promise.resolve();
    },
    makeClient: () => createMockCloudClient(),
    login: () => Promise.resolve(saved.cloud!),
    portalUrl: "https://portal",
  });
  Deno.env.set("PBC_TOKEN", "envtok");
  try {
    const err = await withStderr(() =>
      cmds["logout"].run({}, {
        args: [],
        flags: { json: false, yes: true, noInput: true, interactive: false },
      })
    );
    assertStringIncludes(err, "PBC_TOKEN");
  } finally {
    Deno.env.delete("PBC_TOKEN");
  }
});

Deno.test("the PBC_TOKEN warning stays out of --json output", async () => {
  const saved = defaultConfig();
  Deno.env.set("PBC_TOKEN", "envtok");
  try {
    const err = await withStderr(() =>
      loginCmds(saved, "u1")["login"].run({}, {
        args: [],
        flags: { json: true, yes: true, noInput: true, interactive: false },
      })
    );
    assertEquals(err, "");
  } finally {
    Deno.env.delete("PBC_TOKEN");
  }
});

Deno.test("logout revokes a device token on the server, then forgets it", async () => {
  const saved = defaultConfig();
  saved.cloud = {
    backendUrl: "u",
    extUrl: "x",
    userToken: "pbc_d_token",
    userId: "u1",
  };
  const client = createMockCloudClient({
    pbApi: () =>
      Promise.resolve(
        Response.json({
          token: "pbc_d_token",
          grant: { id: "devaaaaaaaaaaaa", kind: "device" },
        }),
      ),
  });
  const cmds = makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: (c) => {
      Object.assign(saved, c);
      return Promise.resolve();
    },
    makeClient: () => client,
    login: () => Promise.resolve(saved.cloud!),
    portalUrl: "https://portal",
  });
  await cmds["logout"].run({}, {
    args: [],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(client.calls.ext, [["/api/access-tokens/revoke", {
    id: "devaaaaaaaaaaaa",
  }]]);
  assertEquals(saved.cloud, null);
});

Deno.test("logout leaves a session token alone on the server", async () => {
  const saved = defaultConfig();
  saved.cloud = {
    backendUrl: "u",
    extUrl: "x",
    userToken: "eyJ.session",
    userId: "u1",
  };
  const client = createMockCloudClient();
  const cmds = makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: (c) => {
      Object.assign(saved, c);
      return Promise.resolve();
    },
    makeClient: () => client,
    login: () => Promise.resolve(saved.cloud!),
    portalUrl: "https://portal",
  });
  await cmds["logout"].run({}, {
    args: [],
    flags: { json: true, yes: true, noInput: true, interactive: false },
  });
  assertEquals(client.calls.ext, []);
  assertEquals(saved.cloud, null);
});

Deno.test("login --token warns when given a personal session token, and still logs in", async () => {
  const saved = defaultConfig();
  const warnings: string[] = [];
  const original = console.error;
  console.error = (line: string) => warnings.push(line);
  try {
    const cmds = makeAuthCommands({
      loadConfig: () => Promise.resolve(saved),
      saveConfig: (c) => {
        Object.assign(saved, c);
        return Promise.resolve();
      },
      makeClient: () =>
        createMockCloudClient({
          whoami: () =>
            Promise.resolve({ id: "u9", email: "e", plan: "free" } as never),
        }),
      login: () => Promise.reject(new Error("unused")),
      portalUrl: "https://portal",
    });
    await cmds["login"].run({ token: "eyJ.session.sig" }, {
      args: [],
      flags: { json: true, yes: true, noInput: true, interactive: false },
    });
    assertEquals(saved.cloud?.userToken, "eyJ.session.sig");
    assertEquals(warnings.some((line) => line.includes("Access tokens")), true);
    warnings.length = 0;
    await cmds["login"].run({ token: "pbc_a_token" }, {
      args: [],
      flags: { json: true, yes: true, noInput: true, interactive: false },
    });
    assertEquals(
      warnings.some((line) => line.includes("Access tokens")),
      false,
    );
  } finally {
    console.error = original;
  }
});

async function logoutWith(
  userToken: string,
  overrides: Parameters<typeof createMockCloudClient>[0],
): Promise<
  { stdout: string; stderr: string; saved: ReturnType<typeof defaultConfig> }
> {
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", extUrl: "x", userToken, userId: "u1" };
  const cmds = makeAuthCommands({
    loadConfig: () => Promise.resolve(saved),
    saveConfig: (c) => {
      Object.assign(saved, c);
      return Promise.resolve();
    },
    makeClient: () => createMockCloudClient(overrides),
    login: () => Promise.resolve(saved.cloud!),
    portalUrl: "https://portal",
  });
  const out: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => out.push(args.join(" "));
  try {
    const stderr = await withStderr(() =>
      cmds["logout"].run({}, {
        args: [],
        flags: { json: true, yes: true, noInput: true, interactive: false },
      })
    );
    return { stdout: out.join("\n"), stderr, saved };
  } finally {
    console.log = originalLog;
  }
}

function revokedField(stdout: string): unknown {
  return (JSON.parse(stdout) as { data: { revoked?: unknown } }).data.revoked;
}

Deno.test("logout reports revoked when the server revoked the device token", async () => {
  const { stdout, stderr } = await logoutWith("pbc_d_token", {
    pbApi: () =>
      Promise.resolve(Response.json({ grant: { id: "devaaaaaaaaaaaa" } })),
  });
  assertEquals(revokedField(stdout), true);
  assertEquals(stderr, "");
});

Deno.test("logout warns and reports revoked false when the server refuses auth-refresh", async () => {
  const { stdout, stderr, saved } = await logoutWith("pbc_d_token", {
    pbApi: () =>
      Promise.resolve(Response.json({ message: "expired" }, { status: 401 })),
  });
  assertEquals(revokedField(stdout), false);
  assertStringIncludes(stderr, "Access tokens");
  assertStringIncludes(stderr, "checking this login answered 401");
  assertEquals(stderr.includes("pbc_d_token"), false);
  assertEquals(saved.cloud, null);
});

Deno.test("logout warns and reports revoked false when no grant id comes back", async () => {
  const { stdout, stderr } = await logoutWith("pbc_d_token", {
    pbApi: () => Promise.resolve(Response.json({ token: "pbc_d_token" })),
  });
  assertEquals(revokedField(stdout), false);
  assertStringIncludes(stderr, "Access tokens");
  assertStringIncludes(stderr, "the server did not say which login this is");
});

Deno.test("logout warns and reports revoked false when the revoke call fails", async () => {
  const { stdout, stderr } = await logoutWith("pbc_d_token", {
    pbApi: () =>
      Promise.resolve(Response.json({ grant: { id: "devaaaaaaaaaaaa" } })),
    ext: () =>
      Promise.resolve(Response.json({ success: false }, { status: 500 })),
  });
  assertEquals(revokedField(stdout), false);
  assertStringIncludes(stderr, "Access tokens");
  assertStringIncludes(stderr, "revoking answered 500");
});

Deno.test("logout names a network failure when the server cannot be reached", async () => {
  const { stdout, stderr } = await logoutWith("pbc_d_token", {
    pbApi: () => Promise.reject(new TypeError("error sending request")),
  });
  assertEquals(revokedField(stdout), false);
  assertStringIncludes(
    stderr,
    "could not reach the server (error sending request)",
  );
});

Deno.test("logout of a saved session token says the server login was not ended", async () => {
  const { stdout, stderr } = await logoutWith("eyJ.session", {});
  assertEquals(revokedField(stdout), false);
  assertStringIncludes(stderr, "Sign out everywhere");
});
