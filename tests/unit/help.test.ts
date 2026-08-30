import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildHelpText, buildManifest } from "../../src/help.ts";
import { COMMANDS } from "../../src/usage.ts";
import {
  camelCase,
  type Command,
  type CommandRegistry,
  type FlagSpec,
} from "../../src/command.ts";
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES } from "../../src/globals.ts";

function cmd(path: string[]): Command {
  const key = path.join(" ");
  const spec = COMMANDS[key];
  const flags: Record<string, FlagSpec> = {};
  for (const f of spec?.flags ?? []) {
    flags[camelCase(f.name)] = {
      type: f.type,
      description: f.description ?? "",
      required: f.required,
      ...(f.choices ? { choices: f.choices } : {}),
    };
  }
  return {
    path,
    usage: spec?.usage ?? `pbc ${key}`,
    summary: spec?.summary ?? "",
    args: spec?.args ?? [],
    flags,
    targets: [],
    run: () => Promise.resolve(0),
  } as Command;
}

Deno.test("buildHelpText groups cloud and instance commands", () => {
  const text = buildHelpText({
    "pocketbase ls": cmd(["pocketbase", "ls"]),
    "plan": cmd(["plan"]),
    "init": cmd(["init"]),
    "admin collections ls": cmd(["admin", "collections", "ls"]),
  });
  assertStringIncludes(text, "Usage: pbc <command> [args] [flags]");
  const instanceStart = text.indexOf("Instance commands");
  const cloudStart = text.indexOf("Cloud commands");
  assertEquals(instanceStart < cloudStart, true);
  assertEquals(text.indexOf("  pocketbase ls") > cloudStart, true);
  assertEquals(text.indexOf("  plan") > cloudStart, true);
  assertEquals(text.indexOf("  init") > cloudStart, true);
  assertEquals(text.indexOf("  admin collections ls") > instanceStart, true);
  assertStringIncludes(text, "List PocketBase instances in a project.");
  assertStringIncludes(text, "List collections.");
});

Deno.test("buildHelpText omits the description column for unknown commands", () => {
  const text = buildHelpText({ "totally-made-up": cmd(["totally-made-up"]) });
  assertStringIncludes(text, "  totally-made-up");
});

Deno.test("buildManifest lists every registered command with its spec", () => {
  const manifest = buildManifest({
    "pocketbase ls": cmd(["pocketbase", "ls"]),
    "admin collections ls": cmd(["admin", "collections", "ls"]),
  });
  assertEquals(manifest.commands.length, 2);
  const pbLs = manifest.commands.find((c) => c.command === "pocketbase ls");
  assertEquals(pbLs?.usage, "pbc pocketbase ls");
  assertEquals(pbLs?.summary, "List PocketBase instances in a project.");
});

Deno.test("buildManifest includes the global flags", () => {
  const manifest = buildManifest({});
  const names = manifest.globalFlags.map((f) => f.name).sort();
  assertEquals(
    names,
    [
      "help",
      "interactive",
      "json",
      "no-input",
      "profile",
      "project",
      "version",
      "yes",
    ],
  );
});

Deno.test("buildHelpText groups the local binary commands separately", () => {
  const text = buildHelpText({
    "cloud pb ls": cmd(["cloud", "pb", "ls"]),
    "admin collections ls": cmd(["admin", "collections", "ls"]),
    "local init": cmd(["local", "init"]),
    "local versions": cmd(["local", "versions"]),
  });
  assertStringIncludes(text, "Local commands");
  assertStringIncludes(text, "  local init");
  assertStringIncludes(text, "Download a PocketBase binary");
  assertEquals(
    text.indexOf("\n  local init") > text.indexOf("Local commands"),
    true,
  );
  assertEquals(
    text.indexOf("\n  admin collections ls") > text.indexOf("Instance commands"),
    true,
  );
});

Deno.test("buildHelpText omits the local section when no local commands exist", () => {
  const text = buildHelpText({ "admin collections ls": cmd(["admin", "collections", "ls"]) });
  assertEquals(text.includes("Local commands"), false);
});

Deno.test("buildManifest carries specs for the local commands", () => {
  const manifest = buildManifest({
    "local init": cmd(["local", "init"]),
    "local install": cmd(["local", "install"]),
    "local versions": cmd(["local", "versions"]),
    "local which": cmd(["local", "which"]),
  });
  const init = manifest.commands.find((c) => c.command === "local init");
  assertEquals(init?.usage, "pbc local init [<version>] [--dir <d>] [--force]");
  assertEquals(init?.args[0].name, "version");
  assertEquals(init?.args[0].required, false);
  const install = manifest.commands.find((c) => c.command === "local install");
  assertEquals(install?.flags.some((f) => f.name === "os"), true);
  assertEquals(install?.flags.some((f) => f.name === "arch"), true);
  const versions = manifest.commands.find((c) => c.command === "local versions");
  assertEquals(versions?.flags.some((f) => f.name === "all"), true);
  assertEquals(versions?.flags.some((f) => f.name === "pre"), true);
});

Deno.test("buildManifest omits args/flags for a command without a spec", () => {
  const manifest = buildManifest({
    "totally-made-up": cmd(["totally-made-up"]),
  });
  const entry = manifest.commands.find((c) => c.command === "totally-made-up");
  assertEquals(entry?.usage, "pbc totally-made-up");
  assertEquals(entry?.args, []);
  assertEquals(entry?.flags, []);
});

Deno.test("the rendered global flag block matches the globals object", () => {
  const registry: CommandRegistry = {};
  const text = buildHelpText(registry);
  const block = text.slice(
    text.indexOf("Global flags:"),
    text.indexOf("Instance commands"),
  );
  const rendered = new Set(
    [...block.matchAll(/^ {2}--([a-z][a-z0-9-]*)/gm)].map((m) => m[1]),
  );
  assertEquals(
    [...rendered].sort(),
    [...GLOBAL_FLAG_NAMES].sort(),
    "help.ts's global flag block and GLOBALS disagree",
  );
  for (const f of GLOBAL_FLAGS) {
    if (!f.short) continue;
    if (!block.includes(`--${f.name}, -${f.short}`)) {
      throw new Error(`help.ts does not show -${f.short} beside --${f.name}`);
    }
  }
});
