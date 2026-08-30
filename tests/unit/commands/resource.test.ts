import { assertEquals } from "@std/assert";
import { makeResourceCommands } from "../../../src/commands/resource.ts";
import { ALL_KINDS, KINDS } from "../../../src/kinds.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";

function deps(
  client = createMockCloudClient(),
  currentProject = "",
): CloudCmdDeps {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject,
  };
  const cwd = Deno.makeTempDirSync();
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
  };
}

const flags = (over: Record<string, unknown> = {}) => ({
  json: true,
  yes: true,
  noInput: true,
  interactive: false,
  ...over,
});

Deno.test("every kind gets ls, info and rm", () => {
  for (const spec of ALL_KINDS) {
    const cmds = makeResourceCommands(deps(), spec);
    for (const verb of ["ls", "info", "rm"]) {
      const key = `${spec.noun} ${verb}`;
      assertEquals(typeof cmds[key]?.run, "function", `${key} is missing`);
    }
  }
});

Deno.test("ls lists only the kind it was built for", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  await client.createResource("frontends", { name: "site", project: p.id });
  const lines: string[] = [];
  const original = console.log;
  console.log = (m: string) => lines.push(m);
  try {
    const cmds = makeResourceCommands(deps(client, p.id), KINDS.frontends);
    assertEquals(
      await cmds["frontend ls"].run({}, {
        args: [],
        flags: flags({ project: p.id }),
      }),
      0,
    );
  } finally {
    console.log = original;
  }
  const rows = JSON.parse(lines[lines.length - 1]).data as { name: string }[];
  assertEquals(rows.map((r) => r.name), ["site"]);
});

Deno.test("rm marks the resource deleted through the kind's own collection", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const be = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  const cmds = makeResourceCommands(deps(client, p.id), KINDS.backends);
  const code = await cmds["backend rm"].run({ name: "api" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.updateResource[0], [
    "backends",
    be.id,
    { status: "deleted" },
  ]);
});

Deno.test("info under --json still prints the whole record", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db",
    project: p.id,
  });
  const lines: string[] = [];
  const original = console.log;
  console.log = (m: string) => lines.push(m);
  try {
    const cmds = makeResourceCommands(deps(client, p.id), KINDS.pocketbases);
    await cmds["pocketbase info"].run({ name: "db" }, {
      args: [],
      flags: flags({ project: p.id }),
    });
  } finally {
    console.log = original;
  }
  assertEquals(JSON.parse(lines[lines.length - 1]).data.id, pb.id);
});

Deno.test("every kind that declares domains gets all four verbs", () => {
  for (const spec of ALL_KINDS) {
    const cmds = makeResourceCommands(deps(), spec);
    for (const verb of ["add", "verify", "remove", "status"]) {
      const key = `${spec.noun} domain ${verb}`;
      assertEquals(
        typeof cmds[key]?.run,
        spec.domains ? "function" : "undefined",
        `${key} does not match the table`,
      );
    }
  }
});

Deno.test("each domain verb posts the kind's own id field to its own route", async () => {
  for (const spec of ALL_KINDS.filter((k) => k.domains)) {
    const client = createMockCloudClient();
    const p = await client.createProject("app");
    const r = await client.createResource(spec.kind, {
      name: "thing",
      project: p.id,
    });
    const cmds = makeResourceCommands(deps(client, p.id), spec);
    for (const verb of ["add", "verify", "remove"]) {
      const code = await cmds[`${spec.noun} domain ${verb}`].run(
        { name: "thing" },
        { args: ["example.com"], flags: flags({ project: p.id }) },
      );
      assertEquals(code, 0);
    }
    assertEquals(
      client.calls.ext.map(([path]) => path),
      [
        `/api/${spec.kind}/custom-domain/add`,
        `/api/${spec.kind}/custom-domain/verify`,
        `/api/${spec.kind}/custom-domain/remove`,
      ],
    );
    for (const [, body] of client.calls.ext) {
      assertEquals((body as Record<string, string>)[spec.idField], r.id);
      assertEquals(
        (body as Record<string, string>).custom_domain,
        "example.com",
      );
    }
  }
});

Deno.test("domain status sends no domain and reports the platform's answer", async () => {
  const client = createMockCloudClient({
    ext: (path, body) => {
      (client.calls.ext as [string, unknown][]).push([path, body]);
      return Promise.resolve(
        new Response(
          JSON.stringify({ success: true, data: { reachable: true } }),
          { status: 200 },
        ),
      );
    },
  });
  const p = await client.createProject("app");
  const be = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  const lines: string[] = [];
  const original = console.log;
  console.log = (m: string) => lines.push(m);
  try {
    const cmds = makeResourceCommands(deps(client, p.id), KINDS.backends);
    assertEquals(
      await cmds["backend domain status"].run({ name: "api" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
      0,
    );
  } finally {
    console.log = original;
  }
  assertEquals(client.calls.ext[0][0], "/api/backends/custom-domain/status");
  assertEquals(client.calls.ext[0][1], { backend_id: be.id });
  assertEquals(JSON.parse(lines[lines.length - 1]).data.data.reachable, true);
});
