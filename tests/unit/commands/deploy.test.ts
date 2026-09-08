import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { Command, CmdCtx } from "../../../src/command.ts";
import type { ResourceKind } from "../../../src/clients/types.ts";
import { makeDeployCommands } from "../../../src/commands/deploy.ts";
import { makeFrontendCommands } from "../../../src/commands/frontend.ts";
import { makePbCommands } from "../../../src/commands/pb.ts";
import { makeBackendCommands } from "../../../src/commands/backend.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { createMockDeployFetch } from "../../mocks/deployments.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { CliError } from "../../../src/errors.ts";
import type { PromptIO } from "../../../src/ui/prompt.ts";

function dir(files: Record<string, string> = {}): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

const flags = (over: Record<string, unknown> = {}) => ({
  json: false,
  yes: true,
  noInput: true,
  interactive: false,
  ...over,
});

function fakeIO(inputs: string[]): PromptIO {
  const q = [...inputs];
  return {
    read: () => Promise.resolve(q.shift() ?? null),
    write: () => {},
    isTTY: true,
  };
}

function spies() {
  const seen: { kind: ResourceKind; input: Record<string, unknown>; ctx: CmdCtx }[] =
    [];
  const command = (kind: ResourceKind): Command => ({
    path: [kind],
    usage: "",
    summary: "",
    args: [],
    flags: {},
    run: (input, ctx) => {
      seen.push({ kind, input, ctx });
      return Promise.resolve(0);
    },
  });
  return {
    seen,
    handlers: {
      pocketbases: command("pocketbases"),
      frontends: command("frontends"),
      backends: command("backends"),
    },
  };
}

function captureLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.log = original };
}

function run(
  cwd: string,
  handlers: Record<ResourceKind, Command>,
  ctx: Partial<CmdCtx> = {},
  io?: PromptIO,
) {
  return makeDeployCommands({ cwd: () => cwd, io }, handlers)["deploy"].run(
    {},
    { args: [], flags: flags(), ...ctx } as CmdCtx,
  );
}

Deno.test("each kind of directory reaches its own deploy handler", async () => {
  const cases: [Record<string, string>, ResourceKind][] = [
    [{ "pb_hooks/main.pb.js": "//" }, "pocketbases"],
    [{ "vite.config.ts": "" }, "frontends"],
    [{ "deno.json": "{}" }, "backends"],
  ];
  for (const [files, kind] of cases) {
    const s = spies();
    const log = captureLog();
    try {
      assertEquals(await run(dir(files), s.handlers), 0);
    } finally {
      log.restore();
    }
    assertEquals(s.seen.map((c) => c.kind), [kind]);
  }
});

Deno.test("the detected kind and its evidence are printed before the deploy", async () => {
  const s = spies();
  const log = captureLog();
  try {
    await run(dir({ "vite.config.ts": "" }), s.handlers);
  } finally {
    log.restore();
  }
  assertEquals(log.lines.length, 1);
  assertStringIncludes(log.lines[0], "Detected a frontend");
  assertStringIncludes(log.lines[0], "vite.config.ts");
  assertStringIncludes(log.lines[0], "`pbc frontend deploy`");
});

Deno.test("nothing is printed under --json, where stdout carries the deploy's object", async () => {
  const s = spies();
  const log = captureLog();
  try {
    await run(dir({ "deno.json": "{}" }), s.handlers, {
      flags: flags({ json: true }),
    });
  } finally {
    log.restore();
  }
  assertEquals(log.lines, []);
  assertEquals(s.seen[0].kind, "backends");
});

Deno.test("the context reaches the handler untouched, flags and all", async () => {
  const s = spies();
  const log = captureLog();
  try {
    await run(dir({ "deno.json": "{}" }), s.handlers, {
      args: [],
      flags: flags({ project: "p1" }),
    });
  } finally {
    log.restore();
  }
  assertEquals(s.seen[0].ctx.flags.project, "p1");
  assertEquals(s.seen[0].ctx.args, []);
  assertEquals(s.seen[0].input, {});
});

Deno.test("a positional name is passed through as the handler's first argument", async () => {
  const s = spies();
  const log = captureLog();
  try {
    await run(dir({ "vite.config.ts": "" }), s.handlers, { args: ["web"] });
  } finally {
    log.restore();
  }
  assertEquals(s.seen[0].ctx.args, ["web"]);
});

Deno.test("the handler's exit code is the command's exit code", async () => {
  const stub = (): Command => ({
    path: [],
    usage: "",
    summary: "",
    args: [],
    flags: {},
    run: () => Promise.resolve(6),
  });
  const failing: Record<ResourceKind, Command> = {
    pocketbases: stub(),
    frontends: stub(),
    backends: stub(),
  };
  const log = captureLog();
  try {
    assertEquals(await run(dir({ "deno.json": "{}" }), failing), 6);
  } finally {
    log.restore();
  }
});

Deno.test("a leading kind word overrides a directory that detects otherwise", async () => {
  const s = spies();
  const log = captureLog();
  try {
    await run(dir({ "vite.config.ts": "" }), s.handlers, {
      args: ["backend"],
    });
  } finally {
    log.restore();
  }
  assertEquals(s.seen[0].kind, "backends");
  assertEquals(s.seen[0].ctx.args, []);
  assertEquals(log.lines, []);
});

Deno.test("both PocketBase spellings are accepted, and a name may follow", async () => {
  for (const word of ["pb", "pocketbase"]) {
    const s = spies();
    await run(dir({ "vite.config.ts": "" }), s.handlers, {
      args: [word, "db"],
    });
    assertEquals(s.seen[0].kind, "pocketbases");
    assertEquals(s.seen[0].ctx.args, ["db"]);
  }
});

Deno.test("a word that is not a kind stays a resource name", async () => {
  const s = spies();
  const log = captureLog();
  try {
    await run(dir({ "vite.config.ts": "" }), s.handlers, { args: ["web"] });
  } finally {
    log.restore();
  }
  assertEquals(s.seen[0].kind, "frontends");
  assertEquals(s.seen[0].ctx.args, ["web"]);
});

Deno.test("an explicit kind works in a directory that detects nothing", async () => {
  const s = spies();
  assertEquals(await run(dir(), s.handlers, { args: ["frontend"] }), 0);
  assertEquals(s.seen[0].kind, "frontends");
});

Deno.test("an undetectable directory errors with the three explicit commands", async () => {
  const s = spies();
  const cwd = dir({ "README.md": "#" });
  const err = await assertRejects(
    () => run(cwd, s.handlers),
    CliError,
    "Could not tell what is in",
  );
  assertEquals(err.exitCode, 2);
  assertStringIncludes(err.message, cwd);
  assertStringIncludes(err.message, "pbc pocketbase deploy");
  assertStringIncludes(err.message, "pbc frontend deploy");
  assertStringIncludes(err.message, "pbc backend deploy");
  assertStringIncludes(err.message, "pbc init");
  assertEquals(s.seen, []);
});

Deno.test("--json gets the error rather than a prompt that would corrupt it", async () => {
  const s = spies();
  await assertRejects(
    () =>
      run(
        dir(),
        s.handlers,
        { flags: flags({ json: true, noInput: false }) },
        fakeIO(["2"]),
      ),
    CliError,
    "Could not tell what is in",
  );
  assertEquals(s.seen, []);
});

Deno.test("on a terminal an undetectable directory is asked about", async () => {
  const s = spies();
  const code = await run(
    dir(),
    s.handlers,
    { flags: flags({ noInput: false }) },
    fakeIO(["2"]),
  );
  assertEquals(code, 0);
  assertEquals(s.seen[0].kind, "frontends");
});

Deno.test("the answer to that question deploys the third kind too", async () => {
  const s = spies();
  await run(
    dir(),
    s.handlers,
    { flags: flags({ noInput: false }) },
    fakeIO([
      "3",
    ]),
  );
  assertEquals(s.seen[0].kind, "backends");
});

function deps(
  client = createMockCloudClient(),
  currentProject = "",
  cwd = Deno.makeTempDirSync(),
): CloudCmdDeps {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject,
  };
  const deploy = createMockDeployFetch();
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
    fetch: deploy.fetchFn,
  };
}

function runningNow(client: ReturnType<typeof createMockCloudClient>) {
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
}

function realDeploy(d: CloudCmdDeps) {
  const pb = makePbCommands(d);
  const frontend = makeFrontendCommands(d);
  const backend = makeBackendCommands(d);
  return makeDeployCommands(d, {
    pocketbases: pb["pocketbase deploy"],
    frontends: frontend["frontend deploy"],
    backends: backend["backend deploy"],
  })["deploy"];
}

Deno.test("a static directory deploys as a frontend end to end", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = dir({ "index.html": "<html></html>" });
  const d = deps(client, p.id, cwd);
  runningNow(client);
  const code = await realDeploy(d).run(
    { new: "web", skipBuild: true },
    { args: [], flags: flags({ json: true, project: p.id }) },
  );
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][0], "frontends");
  assertEquals(client.calls.createResource[0][1].name, "web");
  const file = JSON.parse(await Deno.readTextFile(join(cwd, "pbc.json")));
  assertEquals(file.kind, "frontends");
});

Deno.test("a PocketBase directory deploys as a PocketBase instance end to end", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = dir({ "pb_migrations/1_init.js": "//" });
  const d = deps(client, p.id, cwd);
  runningNow(client);
  const code = await realDeploy(d).run(
    { new: "db", pbVersion: "0.34.2", skipBuild: true },
    { args: [], flags: flags({ json: true, project: p.id }) },
  );
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][0], "pocketbases");
});

Deno.test("the binding a first deploy wrote is what the second one follows", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = dir({ "index.html": "<html></html>" });
  const d = deps(client, p.id, cwd);
  runningNow(client);
  const deploy = realDeploy(d);
  await deploy.run(
    { new: "web", skipBuild: true },
    { args: [], flags: flags({ json: true, project: p.id }) },
  );
  Deno.writeTextFileSync(join(cwd, "deno.json"), "{}");
  const code = await deploy.run(
    { skipBuild: true },
    { args: [], flags: flags({ json: true, project: p.id }) },
  );
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 1);
  assertEquals(client.calls.updateResource[0][0], "frontends");
});

Deno.test("an explicit kind that contradicts the binding is refused by the deploy", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = dir({
    "index.html": "<html></html>",
    "pbc.json": JSON.stringify({
      projectId: p.id,
      kind: "frontends",
      defaultEnvironment: "production",
      environments: { production: { id: "f1", name: "web" } },
    }),
  });
  const d = deps(client, p.id, cwd);
  await assertRejects(
    () =>
      realDeploy(d).run(
        { name: "api", runtime: "deno", start: "deno task start" },
        { args: ["backend"], flags: flags({ json: true, project: p.id }) },
      ),
    CliError,
    "pbc.json is bound to frontends",
  );
});

for (const kind of ["pocketbases", "backends"] as const) {
  for (const status of ["success", "failed"] as const) {
    for (const json of [false, true]) {
      Deno.test(`${kind} deploy prints logs after ${status} (json=${json})`, async () => {
        const client = createMockCloudClient();
        const project = await client.createProject("app");
        const resource = await client.createResource(kind, {
          name: "app",
          project: project.id,
          status: "running",
        });
        const cwd = dir(kind === "pocketbases"
          ? { "pb_hooks/main.pb.js": "" }
          : { "main.ts": "console.log('ready');" });
        client.getResource = () => Promise.resolve({ ...resource, status: "running" });
        const config: Config = {
          ...defaultConfig(),
          cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
          currentProject: project.id,
        };
        const deploy = createMockDeployFetch();
        deploy.setStatus(status, "Deployment rejected.");
        const requests: unknown[] = [];
        client.ext = (path, body) => {
          if (path === "/api/logs/stream") requests.push(body);
          return Promise.resolve(new Response('data: {"type":"history","line":"Startup output"}\n\n'));
        };
        const deps: CloudCmdDeps = {
          requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
          loadConfig: () => Promise.resolve(config),
          saveConfig: () => Promise.resolve(),
          cwd: () => cwd,
          fetch: deploy.fetchFn,
        };
        const noun = kind === "pocketbases" ? "pocketbase" : "backend";
        const commands = kind === "pocketbases" ? makePbCommands(deps) : makeBackendCommands(deps);
        const stderr: string[] = [];
        const stdout = captureLog();
        const originalWrite = Deno.stderr.writeSync;
        const originalError = console.error;
        Deno.stderr.writeSync = (bytes) => {
          stderr.push(new TextDecoder().decode(bytes));
          return bytes.length;
        };
        console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
        try {
          const run = () => commands[`${noun} deploy`].run(
            { name: "app", runtime: "deno", skipEnv: true },
            { args: [], flags: flags({ json }) },
          );
          if (status === "failed") {
            await assertRejects(run, CliError, "Deployment rejected.");
          } else {
            assertEquals(await run(), 0);
          }
          assertStringIncludes(stderr.join(""), "Startup output");
          assertEquals(requests, [{ target_id: resource.id, type: noun, initial_lines: 50 }]);
          if (json && status === "success") {
            assertEquals(stdout.lines.length, 1);
            assertEquals(JSON.parse(stdout.lines[0]).data.id, resource.id);
          }
        } finally {
          Deno.stderr.writeSync = originalWrite;
          console.error = originalError;
          stdout.restore();
          await Deno.remove(cwd, { recursive: true });
        }
      });
    }
  }
}
