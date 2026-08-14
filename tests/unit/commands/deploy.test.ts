import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { CmdCtx, Handler } from "../../../src/router.ts";
import type { ResourceKind } from "../../../src/clients/types.ts";
import { makeDeployCommands } from "../../../src/commands/deploy.ts";
import { makeFrontendCommands } from "../../../src/commands/frontend.ts";
import { makePbCommands } from "../../../src/commands/pb.ts";
import { makeBackendCommands } from "../../../src/commands/backend.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { CliError } from "../../../src/errors.ts";
import type { PromptIO } from "../../../src/ui/prompt.ts";

/** A temp directory seeded with the given relative path → contents. */
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

/** Records which handler ran and with what, instead of deploying anything. */
function spies() {
  const seen: { kind: ResourceKind; ctx: CmdCtx }[] = [];
  const handler = (kind: ResourceKind): Handler => (ctx) => {
    seen.push({ kind, ctx });
    return Promise.resolve(0);
  };
  return {
    seen,
    handlers: {
      pocketbases: handler("pocketbases"),
      frontends: handler("frontends"),
      backends: handler("backends"),
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
  handlers: Record<ResourceKind, Handler>,
  ctx: Partial<CmdCtx> = {},
  io?: PromptIO,
) {
  return makeDeployCommands({ cwd: () => cwd, io }, handlers)["cloud deploy"]({
    args: [],
    flags: flags(),
    raw: {},
    ...ctx,
  } as CmdCtx);
}

// ===================================================================
// Detection → the matching deploy
// ===================================================================

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
  assertStringIncludes(log.lines[0], "`pb cloud frontend deploy`");
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
  const raw = { name: "api", runtime: "deno", "skip-build": true };
  try {
    await run(dir({ "deno.json": "{}" }), s.handlers, {
      args: [],
      flags: flags({ project: "p1" }),
      raw,
    });
  } finally {
    log.restore();
  }
  assertEquals(s.seen[0].ctx.raw, raw);
  assertEquals(s.seen[0].ctx.flags.project, "p1");
  assertEquals(s.seen[0].ctx.args, []);
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
  const failing: Record<ResourceKind, Handler> = {
    pocketbases: () => Promise.resolve(6),
    frontends: () => Promise.resolve(6),
    backends: () => Promise.resolve(6),
  };
  const log = captureLog();
  try {
    assertEquals(await run(dir({ "deno.json": "{}" }), failing), 6);
  } finally {
    log.restore();
  }
});

// ===================================================================
// The explicit kind word
// ===================================================================

Deno.test("a leading kind word overrides a directory that detects otherwise", async () => {
  const s = spies();
  const log = captureLog();
  try {
    // Every signal here says frontend; the user says backend.
    await run(dir({ "vite.config.ts": "" }), s.handlers, {
      args: ["backend"],
    });
  } finally {
    log.restore();
  }
  assertEquals(s.seen[0].kind, "backends");
  // Consumed, not forwarded — otherwise it would name the new resource.
  assertEquals(s.seen[0].ctx.args, []);
  // An explicit choice is not a detection, so there is nothing to report.
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

// ===================================================================
// When the directory says nothing
// ===================================================================

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
  assertStringIncludes(err.message, "pb cloud pb deploy");
  assertStringIncludes(err.message, "pb cloud frontend deploy");
  assertStringIncludes(err.message, "pb cloud backend deploy");
  assertStringIncludes(err.message, "pb cloud init");
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
    // 1) PocketBase instance  2) frontend  3) backend
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

// ===================================================================
// Against the real deploy handlers
// ===================================================================

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
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
  };
}

/** Report every polled resource as running so deploy reaches a terminal state. */
function runningNow(client: ReturnType<typeof createMockCloudClient>) {
  const orig = client.getResource.bind(client);
  client.getResource = async (k, id) => ({
    ...(await orig(k, id)),
    status: "running",
  });
}

/** `pb cloud deploy` wired to the real three, exactly as index.ts wires it. */
function realDeploy(d: CloudCmdDeps) {
  const pb = makePbCommands(d);
  const frontend = makeFrontendCommands(d);
  const backend = makeBackendCommands(d);
  return makeDeployCommands(d, {
    pocketbases: pb["cloud pb deploy"],
    frontends: frontend["cloud frontend deploy"],
    backends: backend["cloud backend deploy"],
  })["cloud deploy"];
}

Deno.test("a static directory deploys as a frontend end to end", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = dir({ "index.html": "<html></html>" });
  const d = deps(client, p.id, cwd);
  runningNow(client);
  const code = await realDeploy(d)({
    args: [],
    flags: flags({ json: true, project: p.id }),
    raw: { name: "web", "skip-build": true },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][0], "frontends");
  assertEquals(client.calls.createResource[0][1].name, "web");
  // And the deploy recorded the binding, so the next run needs no detection.
  const file = JSON.parse(await Deno.readTextFile(join(cwd, "pb.json")));
  assertEquals(file.kind, "frontends");
});

Deno.test("a PocketBase directory deploys as a PocketBase instance end to end", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = dir({ "pb_migrations/1_init.js": "//" });
  const d = deps(client, p.id, cwd);
  runningNow(client);
  const code = await realDeploy(d)({
    args: [],
    flags: flags({ json: true, project: p.id }),
    raw: { name: "db", "pb-version": "0.34.2", "skip-build": true },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource[0][0], "pocketbases");
});

Deno.test("the binding a first deploy wrote is what the second one follows", async () => {
  // The point of rule 1: once the platform holds a frontend for this
  // directory, adding a deno.json must not start deploying a backend over it.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = dir({ "index.html": "<html></html>" });
  const d = deps(client, p.id, cwd);
  runningNow(client);
  const deploy = realDeploy(d);
  await deploy({
    args: [],
    flags: flags({ json: true, project: p.id }),
    raw: { name: "web", "skip-build": true },
  });
  Deno.writeTextFileSync(join(cwd, "deno.json"), "{}");
  const code = await deploy({
    args: [],
    flags: flags({ json: true, project: p.id }),
    raw: { "skip-build": true },
  });
  assertEquals(code, 0);
  assertEquals(client.calls.createResource.length, 1);
  assertEquals(client.calls.updateResource[0][0], "frontends");
});

Deno.test("an explicit kind that contradicts the binding is refused by the deploy", async () => {
  // deploy.ts does not second-guess the word; the kind check inside the
  // handler is what catches it, with the message that names both kinds.
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const cwd = dir({
    "index.html": "<html></html>",
    "pb.json": JSON.stringify({
      projectId: p.id,
      kind: "frontends",
      defaultEnvironment: "production",
      environments: { production: { id: "f1", name: "web" } },
    }),
  });
  const d = deps(client, p.id, cwd);
  await assertRejects(
    () =>
      realDeploy(d)({
        args: ["backend"],
        flags: flags({ json: true, project: p.id }),
        raw: { name: "api", runtime: "deno", start: "deno task start" },
      }),
    CliError,
    "pb.json is bound to frontends",
  );
});
