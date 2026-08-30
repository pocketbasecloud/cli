import { assertEquals } from "@std/assert";
import { ALL_KINDS, kindByAlias, KINDS, kindsWith } from "../../src/kinds.ts";
import { COMMANDS } from "../../src/usage.ts";
import { registerCommands } from "../../src/commands/index.ts";
import {
  type CommandRegistry,
  requiresExplicitTarget,
  targetKindOf,
} from "../../src/command.ts";
import { targetsOf } from "../../src/targets.ts";

Deno.test("the table declares exactly the capabilities the platform serves", () => {
  assertEquals(kindsWith("domains").map((k) => k.kind), [
    "pocketbases",
    "frontends",
    "backends",
  ]);
  assertEquals(kindsWith("env").map((k) => k.kind), ["pocketbases", "backends"]);
  assertEquals(kindsWith("logs").map((k) => k.kind), ["pocketbases", "backends"]);
  assertEquals(kindsWith("admin").map((k) => k.kind), ["pocketbases"]);
});

Deno.test("every kind that declares env or logs names the type the platform expects", () => {
  for (const spec of ALL_KINDS) {
    if (spec.env || spec.logs) {
      assertEquals(
        typeof spec.apiType,
        "string",
        `${spec.kind} needs an apiType`,
      );
    }
  }
  assertEquals(KINDS.pocketbases.apiType, "pocketbase");
  assertEquals(KINDS.backends.apiType, "backend");
});

Deno.test("every kind's custom-domain id field matches its route family", () => {
  assertEquals(KINDS.pocketbases.idField, "pocketbase_id");
  assertEquals(KINDS.frontends.idField, "frontend_id");
  assertEquals(KINDS.backends.idField, "backend_id");
});

Deno.test("aliases resolve to their kind and nothing else does", () => {
  assertEquals(kindByAlias("pb")?.kind, "pocketbases");
  assertEquals(kindByAlias("pocketbase")?.kind, "pocketbases");
  assertEquals(kindByAlias("PB")?.kind, "pocketbases");
  assertEquals(kindByAlias("frontend")?.kind, "frontends");
  assertEquals(kindByAlias("backend")?.kind, "backends");
  assertEquals(kindByAlias("nope"), null);
});

Deno.test("the prose a kind is described with lives in one row", () => {
  assertEquals(KINDS.pocketbases.label, "PocketBase");
  assertEquals(KINDS.pocketbases.display, "PocketBase instance");
  assertEquals(KINDS.frontends.display, "frontend");
  assertEquals(KINDS.backends.display, "backend");
});

Deno.test("env and logs accept exactly the kinds whose capability is true", () => {
  const envNouns = kindsWith("env").map((k) => k.noun);
  const target = COMMANDS["env ls"].flags.find((f) => f.name === "target");
  assertEquals(target?.choices, envNouns);

  const logNouns = kindsWith("logs").map((k) => k.noun);
  assertEquals(COMMANDS["logs"].args[0].name, logNouns.join("|"));
  assertEquals(
    COMMANDS["logs"].usage.startsWith(
      `pbc logs <${logNouns.join("|")}>`,
    ),
    true,
  );
});

Deno.test("target layers follow the canonical first segment", () => {
  const registry: CommandRegistry = {};
  registerCommands(registry);
  assertEquals(targetsOf(registry["pocketbase ls"]), ["cloud"]);
  assertEquals(targetsOf(registry["frontend ls"]), ["cloud"]);
  assertEquals(targetsOf(registry["deploy"]), ["cloud"]);
  assertEquals(targetsOf(registry["init"]), ["cloud"]);
  assertEquals(targetsOf(registry["plan"]), ["cloud"]);
  assertEquals(targetsOf(registry["env ls"]), ["cloud"]);
  assertEquals(targetsOf(registry["local install"]), ["local"]);
  assertEquals(targetsOf(registry["local versions"]), ["local"]);
  assertEquals(targetsOf(registry["self upgrade"]), []);
  assertEquals(targetsOf(registry["logs"]), ["cloud"]);
  assertEquals(targetsOf(registry["ci init"]), ["cloud"]);
  assertEquals(targetsOf(registry["login"]), ["cloud"]);
  assertEquals(targetsOf(registry["logout"]), ["cloud"]);
  assertEquals(targetsOf(registry["whoami"]), ["cloud"]);
  assertEquals(
    targetsOf(registry["admin collections ls"]),
    ["cloud", "local", "external"],
  );
});

Deno.test("a legacy alias inherits its canonical command's layer", () => {
  const registry: CommandRegistry = {};
  registerCommands(registry);
  assertEquals(targetsOf(registry["cloud pb ls"]), ["cloud"]);
  assertEquals(targetsOf(registry["cloud deploy"]), ["cloud"]);
  assertEquals(targetsOf(registry["upgrade"]), []);
});

Deno.test("the instance-admin families run against all three layers", () => {
  const registry: CommandRegistry = {};
  registerCommands(registry);
  assertEquals(targetsOf(registry["admin collections ls"]), [
    "cloud",
    "local",
    "external",
  ]);
  assertEquals(targetsOf(registry["admin records ls"]), [
    "cloud",
    "local",
    "external",
  ]);
  assertEquals(targetsOf(registry["admin login"]), [
    "cloud",
    "local",
    "external",
  ]);
});

Deno.test("the version manager is local and the CLI's own upgrade has no layer", () => {
  const registry: CommandRegistry = {};
  registerCommands(registry);
  assertEquals(targetsOf(registry["local install"]), ["local"]);
  assertEquals(targetsOf(registry["local versions"]), ["local"]);
  assertEquals(targetsOf(registry["self upgrade"]), []);
});

Deno.test("commands that address a resource declare it; mutations demand explicit intent", () => {
  const registry: CommandRegistry = {};
  registerCommands(registry);

  const modes: Record<string, "read" | "mutate"> = {};
  for (const spec of ALL_KINDS) {
    modes[`${spec.noun} info`] = "read";
    modes[`${spec.noun} rm`] = "mutate";
    modes[`${spec.noun} deploy`] = "mutate";
    if (spec.domains) {
      for (const v of ["add", "verify", "remove"]) {
        modes[`${spec.noun} domain ${v}`] = "mutate";
      }
      modes[`${spec.noun} domain status`] = "read";
    }
  }

  for (const [key, mode] of Object.entries(modes)) {
    const cmd = registry[key];
    assertEquals(Boolean(cmd), true, `${key} should be registered`);
    assertEquals(
      typeof targetKindOf(cmd),
      "string",
      `${key} should declare target:<kind>`,
    );
    assertEquals(
      requiresExplicitTarget(cmd),
      mode === "mutate",
      `${key} should${mode === "mutate" ? "" : " not"} require explicit intent`,
    );
  }

  assertEquals(targetKindOf(registry["pocketbase create"]), undefined);
  assertEquals(targetKindOf(registry["pocketbase ls"]), undefined);
});

Deno.test("an unknown top-level family is a build error, not a silent default", () => {
  let threw = false;
  try {
    targetsOf({
      path: ["surprise"],
      usage: "",
      summary: "",
      args: [],
      flags: {},
      run: () => Promise.resolve(0),
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
