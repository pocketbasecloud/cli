import { assertEquals, assertRejects } from "@std/assert";
import { makeSelfDrivingCommands } from "../../../src/commands/self-driving.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { CliError } from "../../../src/errors.ts";
import type { CmdCtx } from "../../../src/command.ts";

function setup(client = createMockCloudClient()) {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  const deps: CloudCmdDeps = {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => Deno.cwd(),
  };
  return { client, deps };
}

function captureLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.log = original };
}

const ctx = (json = true): CmdCtx => ({
  args: [],
  flags: { json, yes: false, noInput: true, interactive: false },
});

Deno.test("self-driving status reports the account switch", async () => {
  const { client, deps } = setup();
  client.whoami = () =>
    Promise.resolve({
      id: "u1",
      email: "u@e.com",
      plan: "free",
      selfDriving: true,
      selfDrivingJudge: false,
    });
  const log = captureLog();
  try {
    const code = await makeSelfDrivingCommands(deps)["self-driving status"].run(
      {},
      ctx(),
    );
    assertEquals(code, 0);
  } finally {
    log.restore();
  }
  assertEquals(JSON.parse(log.lines.at(-1)!).data, {
    enabled: true,
    judge: false,
  });
});

Deno.test("self-driving status is off when the account never acknowledged", async () => {
  const { client, deps } = setup();
  client.whoami = () =>
    Promise.resolve({ id: "u1", email: "u@e.com", plan: "free" });
  const log = captureLog();
  try {
    await makeSelfDrivingCommands(deps)["self-driving status"].run({}, ctx());
  } finally {
    log.restore();
  }
  assertEquals(JSON.parse(log.lines.at(-1)!).data, {
    enabled: false,
    judge: false,
  });
});

Deno.test("self-driving enable acknowledges the platform key", async () => {
  const { client, deps } = setup();
  await makeSelfDrivingCommands(deps)["self-driving enable"].run({}, ctx());
  assertEquals(client.calls.ext.at(-1), [
    "/api/account/update",
    { agentPlatformKeyAcknowledged: true },
  ]);
});

Deno.test("self-driving disable clears the acknowledgment", async () => {
  const { client, deps } = setup();
  await makeSelfDrivingCommands(deps)["self-driving disable"].run({}, ctx());
  assertEquals(client.calls.ext.at(-1), [
    "/api/account/update",
    { agentPlatformKeyAcknowledged: false },
  ]);
});

Deno.test("self-driving enable surfaces a platform refusal", async () => {
  const { client, deps } = setup();
  client.ext = () =>
    Promise.resolve(
      Response.json({ success: false, error: "Not allowed" }, { status: 400 }),
    );
  await assertRejects(
    () => makeSelfDrivingCommands(deps)["self-driving enable"].run({}, ctx()),
    CliError,
  );
});
