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
  const code = await cmds["cloud whoami"]({
    args: [],
    flags: { json: true, yes: false, noInput: true, interactive: false },
    raw: {},
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
  await cmds["cloud logout"]({
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
    raw: {},
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
  await loginCmds(saved, "u2")["cloud login"]({
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
    raw: {},
  });
  assertEquals(saved.cloud?.userId, "u2");
  assertEquals(saved.currentProject, null);
});

Deno.test("login as the same user keeps the selected project", async () => {
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" };
  saved.currentProject = "proj1";
  await loginCmds(saved, "u1")["cloud login"]({
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
    raw: {},
  });
  assertEquals(saved.currentProject, "proj1");
});

Deno.test("login without a user id clears the selected project", async () => {
  // A callback that carries no user id leaves both sides "" — comparing them
  // says "same account" for what may be a different one, so the previous
  // account's project would survive into a login that cannot see it.
  const saved = defaultConfig();
  saved.cloud = { backendUrl: "u", extUrl: "x", userToken: "t", userId: "" };
  saved.currentProject = "proj1";
  await loginCmds(saved, "")["cloud login"]({
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
    raw: {},
  });
  assertEquals(saved.currentProject, null);
});

/** Run `fn` with stderr captured, so a warning can be asserted on. */
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
      loginCmds(saved, "u1")["cloud login"]({
        args: [],
        flags: { json: false, yes: true, noInput: true, interactive: false },
        raw: {},
      })
    );
    // Without this, "Logged in." is followed by commands acting as the env
    // token — a 401 or a wrong-account write with nothing explaining either.
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
      cmds["cloud logout"]({
        args: [],
        flags: { json: false, yes: true, noInput: true, interactive: false },
        raw: {},
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
      loginCmds(saved, "u1")["cloud login"]({
        args: [],
        flags: { json: true, yes: true, noInput: true, interactive: false },
        raw: {},
      })
    );
    assertEquals(err, "");
  } finally {
    Deno.env.delete("PBC_TOKEN");
  }
});
