import { assertEquals } from "@std/assert";
import type { Command, CommandRegistry } from "../../src/command.ts";
import { canonicalKeys } from "../../src/command.ts";
import { applyLegacyAliases, LEGACY_RENAMES } from "../../src/legacy.ts";

function cmd(path: string[]): Command {
  return {
    path,
    usage: `pbc ${path.join(" ")}`,
    summary: "",
    args: [],
    flags: {},
    run: () => Promise.resolve(0),
  } as Command;
}

Deno.test("a renamed command is registered under its legacy spelling too", () => {
  const registry: CommandRegistry = {
    "pocketbase deploy": cmd(["pocketbase", "deploy"]),
  };
  applyLegacyAliases(registry, [{ old: "cloud pb", new: "pocketbase" }]);
  assertEquals(registry["cloud pb deploy"], registry["pocketbase deploy"]);
});

Deno.test("a legacy key never shadows an existing canonical key", () => {
  const buildConfig = cmd(["init"]);
  const registry: CommandRegistry = {
    "init": buildConfig,
    "local init": cmd(["local", "init"]),
  };
  applyLegacyAliases(registry, [{ old: "init", new: "local init" }]);
  assertEquals(registry["init"], buildConfig);
});

Deno.test("bare init is the build-config command, and cloud init aliases it", () => {
  const buildConfig = cmd(["init"]);
  const registry: CommandRegistry = {
    "init": buildConfig,
    "local init": cmd(["local", "init"]),
  };
  applyLegacyAliases(registry, [
    { old: "cloud init", new: "init" },
    { old: "init", new: "local init" },
  ]);
  assertEquals(registry["init"], buildConfig);
  assertEquals(registry["cloud init"], buildConfig);
});

Deno.test("prefix matches are token-wise, never substring", () => {
  const registry: CommandRegistry = { "environments": cmd(["environments"]) };
  applyLegacyAliases(registry, [{ old: "cloud env", new: "env" }]);
  assertEquals(registry["cloud environments"], undefined);
});

Deno.test("canonicalKeys excludes alias keys", () => {
  const registry: CommandRegistry = {
    "pocketbase deploy": cmd(["pocketbase", "deploy"]),
    "cloud pb deploy": cmd(["pocketbase", "deploy"]),
  };
  assertEquals(canonicalKeys(registry), ["pocketbase deploy"]);
});

Deno.test("LEGACY_RENAMES pairs each old spelling with its new root", () => {
  const olds = LEGACY_RENAMES.map((r) => r.old);
  for (const expected of [
    "cloud pb",
    "cloud frontend",
    "cloud backend",
    "cloud deploy",
    "cloud env",
    "cloud environments",
    "cloud locations",
    "cloud project",
    "cloud org",
    "cloud compute",
    "cloud server",
    "cloud upgrade",
    "cloud init",
    "init",
    "install",
    "versions",
    "which",
    "upgrade",
    "collections",
    "records",
    "rules",
    "settings",
    "cron",
    "auth",
    "use",
    "cloud logs",
    "cloud ci",
    "cloud login",
    "cloud logout",
    "cloud whoami",
  ]) {
    assertEquals(olds.includes(expected), true, `${expected} is in LEGACY_RENAMES`);
  }
});
