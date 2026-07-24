import { assertEquals } from "@std/assert";
import { makeOrgCommands } from "../../../src/commands/org.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";

function deps(client = createMockCloudClient()): CloudCmdDeps {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
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
