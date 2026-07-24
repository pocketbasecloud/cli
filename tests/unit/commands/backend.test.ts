import { assertEquals } from "@std/assert";
import { makeBackendCommands } from "../../../src/commands/backend.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";

/** A directory with something to package, so deploy has a zip to upload. */
function seedSource(): string {
  const cwd = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${cwd}/main.ts`, "console.log(1);\n");
  return cwd;
}

Deno.test("backend deploy sends runtime and start command", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = seedSource();
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const cmds = makeBackendCommands({
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
  });
  const code = await cmds["cloud backend deploy"]({
    args: [],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
    raw: { name: "api", runtime: "deno", start: "deno task start" },
  });
  assertEquals(code, 0);
  const [, data] = client.calls.createResource[0];
  assertEquals(data.runtime, "deno");
  assertEquals(data.startCommand, "deno task start");
});

Deno.test("backend rm keeps a binding it did not resolve", async () => {
  // `rm --name other` resolved a resource the environment does not track, so
  // the environment must survive.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const bound = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  const other = await client.createResource("backends", {
    name: "api-old",
    project: p.id,
  });
  const cwd = seedSource();
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
    currentProject: p.id,
  };
  const d = {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
  };
  await Deno.writeTextFile(
    `${cwd}/pb.json`,
    JSON.stringify({
      projectId: p.id,
      kind: "backends",
      defaultEnvironment: "production",
      environments: { production: { id: bound.id, name: "api" } },
    }),
  );
  const code = await makeBackendCommands(d)["cloud backend rm"]({
    args: [],
    flags: {
      json: true,
      yes: true,
      noInput: true,
      interactive: false,
      project: p.id,
    },
    raw: { name: "api-old" },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.updateResource[0][1], other.id);
  const file = JSON.parse(await Deno.readTextFile(`${cwd}/pb.json`));
  assertEquals(file.environments, {
    production: { id: bound.id, name: "api" },
  });
});
