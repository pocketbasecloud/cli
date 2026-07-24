import { assertEquals } from "@std/assert";
import { makeFrontendCommands } from "../../../src/commands/frontend.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";

function deps(
  client = createMockCloudClient(),
  currentProject = "",
): CloudCmdDeps {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject,
  };
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => "/tmp",
  };
}

Deno.test("frontend domain add posts to custom-domain/add", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const fe = await client.createResource("frontends", {
    name: "site",
    project: p.id,
  });
  const cmds = makeFrontendCommands(deps(client, p.id));
  const code = await cmds["cloud frontend domain add"]({
    args: ["example.com"],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
    raw: { name: "site" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.ext[0][0], "/api/frontends/custom-domain/add");
  assertEquals(
    (client.calls.ext[0][1] as { frontendId: string }).frontendId,
    fe.id,
  );
});
