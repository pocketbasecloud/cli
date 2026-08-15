import { assertEquals } from "@std/assert";
import { makeLocationCommands } from "../../../src/commands/locations.ts";
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

/** Capture what the command prints so its answer can be asserted. */
function captureLogs(fn: () => Promise<number>): {
  run: Promise<number>;
  logs: () => string[];
} {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => lines.push(String(s));
  return {
    run: fn().finally(() => {
      console.log = orig;
    }),
    logs: () => lines,
  };
}

Deno.test("cloud locations answers for the caller when no project is given", async () => {
  const client = createMockCloudClient();
  const seen: (string | undefined)[] = [];
  client.deployContext = (projectId?: string) => {
    seen.push(projectId);
    return Promise.resolve({
      ownerPlan: "starter",
      isOwner: true,
      organization: "",
      servers: [],
      locations: ["hil", "sin"],
    });
  };
  const cmds = makeLocationCommands(deps(client));

  const { run } = captureLogs(() =>
    cmds["cloud locations"]({
      args: [],
      flags: { json: false, yes: true, noInput: true, interactive: false },
      raw: {},
    })
  );
  assertEquals(await run, 0);
  assertEquals(seen, [undefined]);
});

Deno.test("cloud locations passes --project through to deploy-context", async () => {
  const client = createMockCloudClient();
  const seen: (string | undefined)[] = [];
  client.deployContext = (projectId?: string) => {
    seen.push(projectId);
    return Promise.resolve({
      ownerPlan: "pro",
      isOwner: false,
      organization: "org1",
      servers: [],
      locations: ["hil", "sin"],
    });
  };
  const cmds = makeLocationCommands(deps(client));

  const { run } = captureLogs(() =>
    cmds["cloud locations"]({
      args: [],
      flags: {
        json: false,
        yes: true,
        noInput: true,
        interactive: false,
        project: "p1",
      },
      raw: {},
    })
  );
  assertEquals(await run, 0);
  assertEquals(seen, ["p1"]);
});

Deno.test("cloud locations names every region with a city", async () => {
  const client = createMockCloudClient();
  client.deployContext = () =>
    Promise.resolve({
      ownerPlan: "starter",
      isOwner: true,
      organization: "",
      servers: [],
      locations: ["hil", "hel1", "sin", "vn-sgn"],
    });
  const cmds = makeLocationCommands(deps(client));

  const { run, logs } = captureLogs(() =>
    cmds["cloud locations"]({
      args: [],
      flags: { json: false, yes: true, noInput: true, interactive: false },
      raw: {},
    })
  );
  assertEquals(await run, 0);
  const out = logs().join("\n");
  assertEquals(out.includes("plan: starter"), true);
  assertEquals(out.includes("Hillsboro, OR"), true);
  assertEquals(out.includes("Helsinki"), true);
  assertEquals(out.includes("Singapore"), true);
  assertEquals(out.includes("Ho Chi Minh City"), true);
});

Deno.test("cloud locations --json emits the deploy-context contract", async () => {
  const client = createMockCloudClient();
  client.deployContext = () =>
    Promise.resolve({
      ownerPlan: "starter",
      isOwner: true,
      organization: "",
      servers: [],
      locations: ["hil", "sin"],
    });
  const cmds = makeLocationCommands(deps(client));

  const { run, logs } = captureLogs(() =>
    cmds["cloud locations"]({
      args: [],
      flags: { json: true, yes: true, noInput: true, interactive: false },
      raw: {},
    })
  );
  assertEquals(await run, 0);
  assertEquals(JSON.parse(logs().join("")), {
    ownerPlan: "starter",
    locations: ["hil", "sin"],
  });
});

Deno.test("cloud locations says so when the pool has nothing for the plan", async () => {
  const client = createMockCloudClient();
  client.deployContext = () =>
    Promise.resolve({
      ownerPlan: "starter",
      isOwner: true,
      organization: "",
      servers: [],
      locations: [],
    });
  const cmds = makeLocationCommands(deps(client));

  const { run, logs } = captureLogs(() =>
    cmds["cloud locations"]({
      args: [],
      flags: { json: false, yes: true, noInput: true, interactive: false },
      raw: {},
    })
  );
  assertEquals(await run, 0);
  assertEquals(
    logs().join("\n").includes("No shared-pool regions available"),
    true,
  );
});

Deno.test("cloud locations passes through on an older backend", async () => {
  const client = createMockCloudClient();
  client.deployContext = () =>
    Promise.resolve({
      ownerPlan: "starter",
      isOwner: true,
      organization: "",
      servers: [],
    });
  const cmds = makeLocationCommands(deps(client));

  const { run, logs } = captureLogs(() =>
    cmds["cloud locations"]({
      args: [],
      flags: { json: false, yes: true, noInput: true, interactive: false },
      raw: {},
    })
  );
  assertEquals(await run, 0);
  assertEquals(logs().join("\n").includes("predates"), true);
});
