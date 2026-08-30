import { assertEquals } from "@std/assert";
import {
  nearestFlag,
  parseCommand,
  resolveCommand,
} from "../../src/parse.ts";
import {
  defineCommand,
  kebabCase,
  str,
  bool,
  path,
  renamed,
} from "../../src/command.ts";
import type { CommandRegistry } from "../../src/command.ts";

const DEPLOY = defineCommand({
  path: ["cloud", "pb", "deploy"],
  usage: "pbc cloud pb deploy",
  summary: "",
  args: [],
  flags: {
    name: str({ description: "Which instance." }),
    project2: str({ description: "x" }),
    compute: str({ description: "c" }),
    server: renamed("compute", { description: "old spelling" }),
    skipBuild: bool({ description: "b" }),
    envFile: path({ description: "e" }),
    runtime: str({ description: "r", choices: ["deno", "bun"] }),
  },
  run: () => Promise.resolve(0),
});

const registry: CommandRegistry = { "cloud pb deploy": DEPLOY };

Deno.test("resolveCommand takes the command path before any flag", () => {
  assertEquals(resolveCommand(["cloud", "pb", "deploy", "--json"], registry), {
    path: ["cloud", "pb", "deploy"], command: DEPLOY, rest: ["--json"], args: [],
  });
  assertEquals(resolveCommand(["--project", "p", "cloud", "pb"], registry).path, []);
  const r = resolveCommand(["cloud", "pb", "deploy", "--skip-build", "api"], registry);
  assertEquals(r.args, []);
  const out = parseCommand(DEPLOY, r.rest, r.args, {});
  assertEquals(out.ok, true);
  if (out.ok) assertEquals(out.args, ["api"]);
});

Deno.test("a typo'd flag exits 2 and performs no work", () => {
  const out = parseCommand(DEPLOY, ["--projct", "acme"], [], {});
  assertEquals(out.ok, false);
  if (!out.ok) {
    assertEquals(out.errors.length, 1);
    assertEquals(out.errors[0].kind, "unknown-flag");
    assertEquals(out.errors[0].message.includes("--projct"), true);
    assertEquals(out.errors[0].message.includes("Did you mean --project"), true);
  }
});

Deno.test("unknown flags are reported all at once, with suggestions", () => {
  const out = parseCommand(DEPLOY, ["--projct", "a", "--nooop"], [], {});
  if (!out.ok) {
    assertEquals(out.errors.length, 2);
    assertEquals(out.errors.every((e) => e.kind === "unknown-flag"), true);
  }
});

Deno.test("PBC_ALLOW_UNKNOWN_FLAGS restores silent acceptance", () => {
  const out = parseCommand(DEPLOY, ["--projct", "acme"], [], {
    env: () => "1",
  });
  assertEquals(out.ok, true);
  if (out.ok) assertEquals(out.input.projct, "acme");
});

Deno.test("every declared flag parses, kebab on the CLI and camel in input", () => {
  const out = parseCommand(DEPLOY, [
    "--name", "api", "--skip-build", "--env-file=.env", "--runtime", "deno",
  ], [], {});
  assertEquals(out.ok, true);
  if (out.ok) {
    assertEquals(out.input.name, "api");
    assertEquals(out.input.skipBuild, true);
    assertEquals(out.input.envFile, ".env");
    assertEquals(out.input.runtime, "deno");
  }
});

Deno.test("renamed flags fold into the target; explicit wins", () => {
  const a = parseCommand(DEPLOY, ["--server", "c1"], [], {});
  const b = parseCommand(DEPLOY, ["--compute", "c2", "--server", "c1"], [], {});
  if (a.ok) assertEquals(a.input.compute, "c1");
  if (b.ok) assertEquals(b.input.compute, "c2");
});

Deno.test("flag arity: a value flag with no value is an error", () => {
  const out = parseCommand(DEPLOY, ["--name"], [], {});
  assertEquals(out.ok, false);
  if (!out.ok) assertEquals(out.errors[0].kind, "arity");
});

Deno.test("choices validation reports the valid set", () => {
  const out = parseCommand(DEPLOY, ["--runtime", "rust"], [], {});
  assertEquals(out.ok, false);
  if (!out.ok) {
    assertEquals(out.errors[0].kind, "choices");
    assertEquals(out.errors[0].message.includes("deno, bun"), true);
  }
});

Deno.test("positional arity: fewer than required is an error", () => {
  const rm = defineCommand({
    path: ["cloud", "pb", "rm"], usage: "pbc cloud pb rm", summary: "",
    args: [{ name: "name", required: true }], flags: {},
    run: () => Promise.resolve(0),
  });
  const out = parseCommand(rm, [], [], {});
  assertEquals(out.ok, false);
  if (!out.ok) assertEquals(out.errors[0].kind, "required");
});

Deno.test("too many positionals errors only when args are declared", () => {
  const declared = defineCommand({
    path: ["a"], usage: "pbc a", summary: "",
    args: [{ name: "one", required: true }], flags: {},
    run: () => Promise.resolve(0),
  });
  assertEquals(parseCommand(declared, [], ["x", "y"], {}).ok, false);
  assertEquals(parseCommand(DEPLOY, [], ["api-db"], {}).ok, true);
});

Deno.test("conflicting flags are rejected", () => {
  const cmd = defineCommand({
    path: ["c"], usage: "pbc c", summary: "", args: [],
    flags: {
      a: str({ description: "a" }),
      b: str({ description: "b", conflicts: ["a"] }),
    },
    run: () => Promise.resolve(0),
  });
  assertEquals(parseCommand(cmd, ["--a", "1", "--b", "2"], [], {}).ok, false);
});

Deno.test("-- passthrough is per-command", () => {
  assertEquals(parseCommand(DEPLOY, ["--", "--http=:8090"], [], {}).ok, false);
  const withRun = defineCommand({
    path: ["local", "run"], usage: "pbc local run", summary: "", args: [],
    flags: {}, passthrough: true, run: () => Promise.resolve(0),
  });
  const out = parseCommand(withRun, ["--", "--http=:8090"], [], {});
  assertEquals(out.ok, true);
  if (out.ok) assertEquals(out.passthrough, ["--http=:8090"]);
});

Deno.test("nearestFlag suggests a close spelling", () => {
  const candidates = ["project", "project2", "name", "compute"];
  assertEquals(nearestFlag("projct", candidates), "project");
  assertEquals(nearestFlag("nom", candidates), "name");
  assertEquals(nearestFlag("zzz", candidates), null);
});

Deno.test("every declared flag parses against the real registry", async () => {
  const registry: CommandRegistry = {};
  const { registerCommands } = await import("../../src/commands/index.ts");
  registerCommands(registry);
  for (const command of Object.values(registry)) {
    const bare = parseCommand(command, [], [], {});
    const broken = bare.ok ? [] : bare.errors.filter((e) => e.kind !== "required");
    if (broken.length > 0) {
      throw new Error(
        `${command.path.join(" ")} rejects a bare parse: ${broken[0].message}`,
      );
    }
    for (const [prop, f] of Object.entries(command.flags)) {
      const cli = kebabCase(prop);
      const positional = command.args.filter((a) => a.required).map(() => "x");
      const value = f.choices?.[0] ?? "x";
      const argv = f.type === "boolean" ? [`--${cli}`] : [`--${cli}`, value];
      const again = parseCommand(command, argv, positional, {});
      if (!again.ok) {
        throw new Error(
          `${command.path.join(" ")} cannot parse --${cli}: ${again.errors[0].message}`,
        );
      }
    }
  }
});

Deno.test("a flag value may start with a single dash when it is not a flag", () => {
  const SORT = defineCommand({
    path: ["records", "ls"],
    usage: "",
    summary: "",
    args: [],
    flags: {
      sort: str({ description: "Sort expression, e.g. -created." }),
      follow: bool({ description: "f", short: "f" }),
    },
    run: () => Promise.resolve(0),
  });
  for (const value of ["-created", "-1", "-"]) {
    const out = parseCommand(SORT, ["--sort", value], [], {});
    assertEquals(out.ok, true);
    if (out.ok) assertEquals(out.input.sort, value);
  }
});

Deno.test("a flag is never swallowed as the value of the flag before it", () => {
  const SORT = defineCommand({
    path: ["records", "ls"],
    usage: "",
    summary: "",
    args: [],
    flags: {
      sort: str({ description: "s" }),
      follow: bool({ description: "f", short: "f" }),
    },
    run: () => Promise.resolve(0),
  });
  for (const next of ["--json", "--jsn", "-f", "--"]) {
    const out = parseCommand(SORT, ["--sort", next], [], {});
    assertEquals(out.ok, false, `--sort ${next} should not parse`);
    if (!out.ok) {
      assertEquals(
        out.errors.some((e) =>
          e.kind === "arity" && e.message.includes("--sort")
        ),
        true,
      );
    }
  }
});

Deno.test("a declared boolean is false when absent, never missing", () => {
  const out = parseCommand(DEPLOY, [], [], {});
  assertEquals(out.ok, true);
  if (out.ok) {
    assertEquals(out.input.skipBuild, false);
    assertEquals("skipBuild" in out.input, true);
    assertEquals("name" in out.input, false);
  }
  const on = parseCommand(DEPLOY, ["--skip-build"], [], {});
  if (on.ok) assertEquals(on.input.skipBuild, true);
});

Deno.test("a bad short flag is reported as typed, not as a long flag", () => {
  const out = parseCommand(DEPLOY, ["-q"], [], {});
  assertEquals(out.ok, false);
  if (!out.ok) {
    assertEquals(out.errors[0].message.includes("unknown flag -q"), true);
    assertEquals(out.errors[0].message.includes("--q"), false);
  }
});

Deno.test("conflicting flags are matched by their declaration key", () => {
  const CMD = defineCommand({
    path: ["x"],
    usage: "",
    summary: "",
    args: [],
    flags: {
      envFile: path({ description: "e", conflicts: ["skipEnv"] }),
      skipEnv: bool({ description: "s" }),
    },
    run: () => Promise.resolve(0),
  });
  const clash = parseCommand(CMD, ["--env-file", ".env", "--skip-env"], [], {});
  assertEquals(clash.ok, false);
  if (!clash.ok) {
    assertEquals(clash.errors[0].kind, "conflict");
    assertEquals(
      clash.errors[0].message,
      "--env-file and --skip-env cannot be combined.",
    );
  }
  assertEquals(parseCommand(CMD, ["--env-file", ".env"], [], {}).ok, true);
});
