import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  makeEnvironmentsCommands,
  reportRemoval,
} from "../../../src/commands/environments.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";

function deps(cwd: string): CloudCmdDeps {
  const client = createMockCloudClient();
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", userToken: "t", userId: "u1" },
  };
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
  };
}

const FLAGS = { json: true, yes: true, noInput: true, interactive: false };

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.log = original };
}

Deno.test("environments lists each entry and marks the default", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${cwd}/pb.json`,
      JSON.stringify({
        projectId: "p1",
        kind: "frontends",
        defaultEnvironment: "production",
        environments: {
          production: { id: "fe1", name: "web" },
          staging: { id: "fe2", name: "web-staging" },
        },
      }),
    );
    const out = capture();
    let code: number;
    try {
      code = await makeEnvironmentsCommands(deps(cwd))["cloud environments"]({
        args: [],
        flags: FLAGS,
        raw: {},
      });
    } finally {
      out.restore();
    }
    assertEquals(code, 0);
    assertEquals(JSON.parse(out.lines[0]), [
      { environment: "production", name: "web", id: "fe1", default: true },
      {
        environment: "staging",
        name: "web-staging",
        id: "fe2",
        default: false,
      },
    ]);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("environments says how to create one when there are none", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    const out = capture();
    let code: number;
    try {
      code = await makeEnvironmentsCommands(deps(cwd))["cloud environments"]({
        args: [],
        flags: { ...FLAGS, json: false },
        raw: {},
      });
    } finally {
      out.restore();
    }
    assertEquals(code, 0);
    assertStringIncludes(out.lines[0], "deploy with --name to create one");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("reportRemoval explains a repointed default", () => {
  const lines: string[] = [];
  reportRemoval(
    { removed: true, repointedTo: "staging" },
    "production",
    (m) => lines.push(m),
  );
  assertStringIncludes(lines[0], '"staging" is now the default');
});

Deno.test("reportRemoval warns when the default is gone and several remain", () => {
  const lines: string[] = [];
  reportRemoval(
    { removed: true, defaultDropped: true },
    "production",
    (m) => lines.push(m),
  );
  assertStringIncludes(lines[0], "pass --env on the next deploy");
});

Deno.test("reportRemoval stays quiet when nothing changed", () => {
  const lines: string[] = [];
  reportRemoval({ removed: false }, "production", (m) => lines.push(m));
  reportRemoval({ removed: true }, "staging", (m) => lines.push(m));
  assertEquals(lines, []);
});
