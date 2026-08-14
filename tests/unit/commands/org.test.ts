import { assertEquals, assertRejects } from "@std/assert";
import { CliError } from "../../../src/errors.ts";
import { makeOrgCommands } from "../../../src/commands/org.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";

function deps(client = createMockCloudClient()): CloudCmdDeps {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
  };
}

Deno.test("org create makes an org", async () => {
  const client = createMockCloudClient();
  const cmds = makeOrgCommands(deps(client));
  const code = await cmds["cloud org create"]({
    args: ["acme"],
    flags: { json: true, yes: true, noInput: true, interactive: false },
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals((await client.listOrgs()).some((o) => o.name === "acme"), true);
});

Deno.test("org create is refused for a non-staff account", async () => {
  // organizations.createRule is evaluated before any hook, so the platform's
  // own refusal is a bare "Failed to create record." The CLI asks who we are
  // first and says the real reason instead.
  const client = createMockCloudClient({
    whoami: () =>
      Promise.resolve({
        id: "u1",
        email: "u@e.com",
        plan: "pro",
        role: "user",
      }),
  });
  const cmds = makeOrgCommands(deps(client));
  const err = await assertRejects(
    () =>
      cmds["cloud org create"]({
        args: ["acme"],
        flags: { json: true, yes: true, noInput: true, interactive: false },
        raw: {},
      }),
    CliError,
  );
  assertEquals(err.message.includes("platform staff"), true);
  assertEquals(err.exitCode, 3);
  // Refused before the platform was ever asked to create anything.
  assertEquals((await client.listOrgs()).length, 0);
});

Deno.test("org share sets organization on a project", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const o = await client.createOrg("acme");
  const cmds = makeOrgCommands(deps(client));
  const code = await cmds["cloud org share"]({
    args: [p.id],
    flags: { json: true, yes: true, noInput: true, interactive: false },
    raw: { org: o.id },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.shareProject[0], [p.id, o.id]);
});

Deno.test("org share --none unshares", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cmds = makeOrgCommands(deps(client));
  await cmds["cloud org share"]({
    args: [p.id],
    flags: { json: true, yes: true, noInput: true, interactive: false },
    raw: { none: true },
  });
  assertEquals(client.calls.shareProject[0], [p.id, null]);
});
