import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { makeProjectCommands } from "../../../src/commands/project.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import { CliError } from "../../../src/errors.ts";
import type { PromptIO } from "../../../src/ui/prompt.ts";
import { join } from "@std/path";

function fakeIO(inputs: string[]): PromptIO {
  const q = [...inputs];
  return {
    read: () => Promise.resolve(q.shift() ?? null),
    write: () => {},
    isTTY: true,
  };
}

function deps(opts: { cwd?: string; io?: PromptIO } = {}) {
  const client = createMockCloudClient();
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  return {
    client,
    config,
    d: {
      requireAuth: () =>
        Promise.resolve({ client, config, auth: config.cloud! }),
      loadConfig: () => Promise.resolve(config),
      saveConfig: (c: Config) => {
        Object.assign(config, c);
        return Promise.resolve();
      },
      cwd: () => opts.cwd ?? "/tmp",
      io: opts.io,
    },
  };
}

const FLAGS = { json: true, yes: true, noInput: true, interactive: false };

/** A temp dir plus a project seeded with one resource of each kind. */
async function linkFixture(io?: PromptIO) {
  const dir = await Deno.makeTempDir();
  const { client, config, d } = deps({ cwd: dir, io });
  const p = await client.createProject("app");
  config.currentProject = p.id;
  const seeded = {
    pb: await client.createResource("pocketbases", {
      name: "my-db",
      project: p.id,
    }),
    fe: await client.createResource("frontends", {
      name: "web",
      project: p.id,
    }),
    be: await client.createResource("backends", {
      name: "api",
      project: p.id,
    }),
  };
  const read = async () =>
    JSON.parse(await Deno.readTextFile(join(dir, "pb.json")));
  return {
    dir,
    client,
    seeded,
    read,
    cmds: makeProjectCommands(d),
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

Deno.test("project create adds a project", async () => {
  const { client, d } = deps();
  const cmds = makeProjectCommands(d);
  const code = await cmds["cloud project create"]({
    args: ["myapp"],
    flags: { json: true, yes: true, noInput: true, interactive: false },
    raw: {},
  });
  assertEquals(code, 0);
  assertEquals(
    (await client.listProjects()).some((p) => p.name === "myapp"),
    true,
  );
});

Deno.test("project use stores currentProject", async () => {
  const { client, config, d } = deps();
  const p = await client.createProject("app");
  const cmds = makeProjectCommands(d);
  await cmds["cloud project use"]({
    args: [p.id],
    flags: { json: true, yes: true, noInput: true, interactive: false },
    raw: {},
  });
  assertEquals(config.currentProject, p.id);
});

Deno.test("link binds the named resource to the directory", async () => {
  const f = await linkFixture();
  try {
    const code = await f.cmds["cloud link"]({
      args: ["frontend", "web"],
      flags: FLAGS,
      raw: {},
    });
    assertEquals(code, 0);
    assertEquals(await f.read(), {
      projectId: f.seeded.fe.project,
      kind: "frontends",
      defaultEnvironment: "production",
      environments: { production: { id: f.seeded.fe.id, name: "web" } },
    });
  } finally {
    await f.cleanup();
  }
});

Deno.test("link asks which environment when the directory names none", async () => {
  const f = await linkFixture(fakeIO(["staging"]));
  try {
    const code = await f.cmds["cloud link"]({
      args: ["frontend", "web"],
      flags: { ...FLAGS, json: false, noInput: false },
      raw: {},
    });
    assertEquals(code, 0);
    const file = await f.read();
    assertEquals(Object.keys(file.environments), ["staging"]);
    assertEquals(file.defaultEnvironment, "staging");
  } finally {
    await f.cleanup();
  }
});

Deno.test("link accepts both pb and pocketbase for the same kind", async () => {
  for (const word of ["pb", "pocketbase"]) {
    const f = await linkFixture();
    try {
      await f.cmds["cloud link"]({
        args: [word, "my-db"],
        flags: FLAGS,
        raw: {},
      });
      assertEquals((await f.read()).kind, "pocketbases");
    } finally {
      await f.cleanup();
    }
  }
});

Deno.test("link resolves a resource by id", async () => {
  const f = await linkFixture();
  try {
    await f.cmds["cloud link"]({
      args: ["backend", f.seeded.be.id],
      flags: FLAGS,
      raw: {},
    });
    assertEquals((await f.read()).kind, "backends");
    assertEquals((await f.read()).environments.production, {
      id: f.seeded.be.id,
      name: "api",
    });
  } finally {
    await f.cleanup();
  }
});

Deno.test("link rejects an unknown kind and points at `project use`", async () => {
  const f = await linkFixture();
  try {
    const err = await assertRejects(
      () =>
        f.cmds["cloud link"]({
          args: ["my-app"],
          flags: FLAGS,
          raw: {},
        }),
      CliError,
    );
    assertEquals(err.exitCode, 2);
    assertStringIncludes(err.message, 'Unknown kind "my-app"');
    assertStringIncludes(err.message, "pb cloud project use");
    // Nothing was written.
    await assertRejects(() => Deno.readTextFile(join(f.dir, "pb.json")));
  } finally {
    await f.cleanup();
  }
});

Deno.test("link with no args under --no-input errors with the usage line", async () => {
  const f = await linkFixture();
  try {
    const err = await assertRejects(
      () => f.cmds["cloud link"]({ args: [], flags: FLAGS, raw: {} }),
      CliError,
    );
    assertEquals(err.exitCode, 2);
    assertStringIncludes(
      err.message,
      "Usage: pb cloud link <pb|frontend|backend> <name|id>",
    );
    await assertRejects(() => Deno.readTextFile(join(f.dir, "pb.json")));
  } finally {
    await f.cleanup();
  }
});

Deno.test("bare link picks from every kind in the project", async () => {
  // The merged list is ordered pocketbases, frontends, backends — "2" is the frontend.
  const f = await linkFixture(fakeIO(["2"]));
  try {
    await f.cmds["cloud link"]({
      args: [],
      flags: { ...FLAGS, noInput: false },
      raw: {},
    });
    assertEquals((await f.read()).kind, "frontends");
    assertEquals((await f.read()).environments.production, {
      id: f.seeded.fe.id,
      name: "web",
    });
  } finally {
    await f.cleanup();
  }
});

Deno.test("link with a kind only picks from that kind", async () => {
  const f = await linkFixture(fakeIO(["1"]));
  try {
    await f.cmds["cloud link"]({
      args: ["backend"],
      flags: { ...FLAGS, noInput: false },
      raw: {},
    });
    assertEquals((await f.read()).kind, "backends");
    assertEquals((await f.read()).environments.production, {
      id: f.seeded.be.id,
      name: "api",
    });
  } finally {
    await f.cleanup();
  }
});

Deno.test("link errors and writes nothing when the name does not resolve", async () => {
  const f = await linkFixture();
  try {
    const err = await assertRejects(
      () =>
        f.cmds["cloud link"]({
          args: ["frontend", "nope"],
          flags: FLAGS,
          raw: {},
        }),
      CliError,
    );
    assertEquals(err.exitCode, 2);
    assertStringIncludes(err.message, 'No frontend found matching "nope"');
    await assertRejects(() => Deno.readTextFile(join(f.dir, "pb.json")));
  } finally {
    await f.cleanup();
  }
});

Deno.test("link --env adds a second environment beside the first", async () => {
  const f = await linkFixture();
  try {
    await Deno.writeTextFile(
      join(f.dir, "pb.json"),
      JSON.stringify({
        projectId: f.seeded.fe.project,
        pocketbaseVersion: "0.39.9",
        kind: "frontends",
        defaultEnvironment: "production",
        environments: { production: { id: f.seeded.fe.id, name: "web" } },
      }),
    );
    const staging = await f.client.createResource("frontends", {
      name: "web-staging",
      project: f.seeded.fe.project,
    });
    await f.cmds["cloud link"]({
      args: ["frontend", "web-staging"],
      flags: FLAGS,
      raw: { env: "staging" },
    });
    assertEquals(await f.read(), {
      projectId: f.seeded.fe.project,
      pocketbaseVersion: "0.39.9",
      kind: "frontends",
      defaultEnvironment: "production",
      environments: {
        production: { id: f.seeded.fe.id, name: "web" },
        staging: { id: staging.id, name: "web-staging" },
      },
    });
  } finally {
    await f.cleanup();
  }
});

Deno.test("link refuses a directory already bound to another kind", async () => {
  // `kind` is shared by every environment, so overwriting it would orphan the
  // ids the other environments hold.
  const f = await linkFixture();
  try {
    await Deno.writeTextFile(
      join(f.dir, "pb.json"),
      JSON.stringify({
        projectId: f.seeded.fe.project,
        kind: "frontends",
        defaultEnvironment: "production",
        environments: { production: { id: f.seeded.fe.id, name: "web" } },
      }),
    );
    const err = await assertRejects(
      () =>
        f.cmds["cloud link"]({
          args: ["backend", "api"],
          flags: FLAGS,
          raw: {},
        }),
      CliError,
    );
    assertEquals(err.exitCode, 2);
    assertStringIncludes(err.message, "pb.json is bound to frontends");
    assertEquals((await f.read()).kind, "frontends");
  } finally {
    await f.cleanup();
  }
});

function captureLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.log = original };
}

Deno.test("link announces the project resolved from config.currentProject", async () => {
  const f = await linkFixture(fakeIO([""]));
  const log = captureLog();
  try {
    const code = await f.cmds["cloud link"]({
      args: ["frontend", "web"],
      flags: { ...FLAGS, json: false, noInput: false },
      raw: {},
    });
    assertEquals(code, 0);
    assertEquals(log.lines[0].includes("Project: app"), true);
    assertEquals(log.lines[0].includes("pb cloud project use"), true);
  } finally {
    log.restore();
    await f.cleanup();
  }
});

Deno.test("link does not announce the project when --project names it", async () => {
  const f = await linkFixture();
  const log = captureLog();
  try {
    await f.cmds["cloud link"]({
      args: ["frontend", "web"],
      flags: { ...FLAGS, json: false, project: f.seeded.fe.project },
      raw: {},
    });
    assertEquals(log.lines.some((l) => l.startsWith("Project:")), false);
  } finally {
    log.restore();
    await f.cleanup();
  }
});

Deno.test("link records the env file chosen for a fresh environment", async () => {
  const f = await linkFixture(fakeIO(["", "2"]));
  try {
    await Deno.writeTextFile(join(f.dir, ".env"), "A=1\n");
    const code = await f.cmds["cloud link"]({
      args: ["pb", "my-db"],
      flags: { ...FLAGS, json: false, noInput: false },
      raw: {},
    });
    assertEquals(code, 0);
    const file = await f.read();
    assertEquals(
      file.environments.production.build,
      { envFile: ".env" },
    );
    assertEquals(f.client.calls.ext, []);
  } finally {
    await f.cleanup();
  }
});

Deno.test('link records "no env file" when the user declines', async () => {
  const f = await linkFixture(fakeIO(["", "1"]));
  try {
    await Deno.writeTextFile(join(f.dir, ".env"), "A=1\n");
    await f.cmds["cloud link"]({
      args: ["pb", "my-db"],
      flags: { ...FLAGS, json: false, noInput: false },
      raw: {},
    });
    const file = await f.read();
    assertEquals(file.environments.production.build, { envFile: "" });
  } finally {
    await f.cleanup();
  }
});

Deno.test("link asks nothing when the directory has no dotenv file", async () => {
  const f = await linkFixture(fakeIO(["", "should not be read"]));
  try {
    const code = await f.cmds["cloud link"]({
      args: ["pb", "my-db"],
      flags: { ...FLAGS, json: false, noInput: false },
      raw: {},
    });
    assertEquals(code, 0);
    const file = await f.read();
    assertEquals(file.environments.production.build, undefined);
  } finally {
    await f.cleanup();
  }
});

Deno.test("link asks nothing for a frontend even with a dotenv file present", async () => {
  const f = await linkFixture(fakeIO(["", "should not be read"]));
  try {
    await Deno.writeTextFile(join(f.dir, ".env"), "A=1\n");
    const code = await f.cmds["cloud link"]({
      args: ["frontend", "web"],
      flags: { ...FLAGS, json: false, noInput: false },
      raw: {},
    });
    assertEquals(code, 0);
    const file = await f.read();
    assertEquals(file.environments.production.build, undefined);
  } finally {
    await f.cleanup();
  }
});

Deno.test("link --env-file records the named file without prompting", async () => {
  const f = await linkFixture();
  try {
    await Deno.writeTextFile(join(f.dir, ".env.custom"), "A=1\n");
    const code = await f.cmds["cloud link"]({
      args: ["pb", "my-db"],
      flags: FLAGS,
      raw: { "env-file": ".env.custom" },
    });
    assertEquals(code, 0);
    const file = await f.read();
    assertEquals(file.environments.production.build, {
      envFile: ".env.custom",
    });
  } finally {
    await f.cleanup();
  }
});

Deno.test("link --env-file naming a missing file fails before pb.json is written", async () => {
  const f = await linkFixture();
  try {
    const err = await assertRejects(
      () =>
        f.cmds["cloud link"]({
          args: ["pb", "my-db"],
          flags: FLAGS,
          raw: { "env-file": ".env.missing" },
        }),
      CliError,
    );
    assertEquals(err.exitCode, 2);
    await assertRejects(() => Deno.readTextFile(join(f.dir, "pb.json")));
  } finally {
    await f.cleanup();
  }
});

Deno.test("link --skip-env records nothing even with a dotenv file present", async () => {
  const f = await linkFixture();
  try {
    await Deno.writeTextFile(join(f.dir, ".env"), "A=1\n");
    const code = await f.cmds["cloud link"]({
      args: ["pb", "my-db"],
      flags: FLAGS,
      raw: { "skip-env": true },
    });
    assertEquals(code, 0);
    const file = await f.read();
    assertEquals(file.environments.production.build, undefined);
  } finally {
    await f.cleanup();
  }
});

Deno.test("re-linking an environment with a recorded env file asks nothing and needs no file on disk", async () => {
  const f = await linkFixture();
  try {
    await Deno.writeTextFile(
      join(f.dir, "pb.json"),
      JSON.stringify({
        projectId: f.seeded.pb.project,
        kind: "pocketbases",
        defaultEnvironment: "production",
        environments: {
          production: {
            id: f.seeded.pb.id,
            name: "my-db",
            build: { envFile: ".env.gone" },
          },
        },
      }),
    );
    const code = await f.cmds["cloud link"]({
      args: ["pb", "my-db"],
      flags: FLAGS,
      raw: { "env-file": ".env.also-ignored" },
    });
    assertEquals(code, 0);
    const file = await f.read();
    assertEquals(file.environments.production.build, { envFile: ".env.gone" });
  } finally {
    await f.cleanup();
  }
});

Deno.test("link suppresses the recorded-envFile line under --json", async () => {
  const f = await linkFixture();
  const log = captureLog();
  try {
    await Deno.writeTextFile(join(f.dir, ".env.custom"), "A=1\n");
    await f.cmds["cloud link"]({
      args: ["pb", "my-db"],
      flags: FLAGS,
      raw: { "env-file": ".env.custom" },
    });
    assertEquals(
      log.lines.some((l) => l.includes("Recorded envFile")),
      false,
    );
  } finally {
    log.restore();
    await f.cleanup();
  }
});

Deno.test("unlink clears the binding and keeps the rest of pb.json", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { d } = deps({ cwd: dir });
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({
        projectId: "p1",
        pocketbaseVersion: "0.39.9",
        kind: "frontends",
        defaultEnvironment: "production",
        environments: { production: { id: "fe1", name: "web" } },
      }),
    );
    const code = await makeProjectCommands(d)["cloud unlink"]({
      args: [],
      flags: FLAGS,
      raw: {},
    });
    assertEquals(code, 0);
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, "pb.json"))), {
      projectId: "p1",
      pocketbaseVersion: "0.39.9",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unlink is a no-op when nothing is bound", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { d } = deps({ cwd: dir });
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({ projectId: "p1" }),
    );
    const code = await makeProjectCommands(d)["cloud unlink"]({
      args: [],
      flags: FLAGS,
      raw: {},
    });
    assertEquals(code, 0);
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, "pb.json"))), {
      projectId: "p1",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unlink does not walk up to a parent pb.json", async () => {
  const parent = await Deno.makeTempDir();
  try {
    const child = join(parent, "frontend");
    await Deno.mkdir(child);
    const parentFile = JSON.stringify({
      projectId: "p1",
      kind: "frontends",
      defaultEnvironment: "production",
      environments: { production: { id: "fe1", name: "web" } },
    });
    await Deno.writeTextFile(join(parent, "pb.json"), parentFile);
    const { d } = deps({ cwd: child });
    await makeProjectCommands(d)["cloud unlink"]({
      args: [],
      flags: FLAGS,
      raw: {},
    });
    assertEquals(await Deno.readTextFile(join(parent, "pb.json")), parentFile);
    // And no file was created in the child.
    await assertRejects(() => Deno.readTextFile(join(child, "pb.json")));
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
