import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildHelpText, buildManifest } from "../../src/help.ts";

Deno.test("buildHelpText groups cloud and instance commands", () => {
  const text = buildHelpText({
    "cloud pb ls": () => Promise.resolve(0),
    "collections ls": () => Promise.resolve(0),
  });
  assertStringIncludes(text, "Usage: pb <command> [args] [flags]");
  assertStringIncludes(text, "Cloud commands");
  assertStringIncludes(text, "  cloud pb ls");
  assertStringIncludes(text, "List PocketBase instances in a project.");
  assertStringIncludes(text, "Instance commands");
  assertStringIncludes(text, "  collections ls");
  assertStringIncludes(text, "List collections.");
});

Deno.test("buildHelpText omits the description column for unknown commands", () => {
  const text = buildHelpText({ "totally-made-up": () => Promise.resolve(0) });
  assertStringIncludes(text, "  totally-made-up");
});

Deno.test("buildManifest lists every registered command with its spec", () => {
  const manifest = buildManifest({
    "cloud pb ls": () => Promise.resolve(0),
    "collections ls": () => Promise.resolve(0),
  });
  assertEquals(manifest.commands.length, 2);
  const pbLs = manifest.commands.find((c) => c.command === "cloud pb ls");
  assertEquals(pbLs?.usage, "pb cloud pb ls [--project <id>]");
  assertEquals(pbLs?.summary, "List PocketBase instances in a project.");
});

Deno.test("buildManifest includes the global flags", () => {
  const manifest = buildManifest({});
  const names = manifest.globalFlags.map((f) => f.name).sort();
  assertEquals(
    names,
    ["help", "json", "no-input", "profile", "project", "version", "yes"],
  );
});

Deno.test("buildHelpText groups the local binary commands separately", () => {
  const text = buildHelpText({
    "cloud pb ls": () => Promise.resolve(0),
    "collections ls": () => Promise.resolve(0),
    "init": () => Promise.resolve(0),
    "versions": () => Promise.resolve(0),
  });
  assertStringIncludes(text, "Local commands");
  assertStringIncludes(text, "  init");
  assertStringIncludes(text, "Download a PocketBase binary");
  // `init` must be listed under the local heading, not the instance one.
  assertEquals(text.indexOf("\n  init") > text.indexOf("Local commands"), true);
  assertEquals(
    text.indexOf("\n  collections ls") > text.indexOf("Instance commands"),
    true,
  );
});

Deno.test("buildHelpText omits the local section when no local commands exist", () => {
  const text = buildHelpText({ "collections ls": () => Promise.resolve(0) });
  assertEquals(text.includes("Local commands"), false);
});

Deno.test("buildManifest carries specs for the local commands", () => {
  const manifest = buildManifest({
    "init": () => Promise.resolve(0),
    "install": () => Promise.resolve(0),
    "versions": () => Promise.resolve(0),
    "which": () => Promise.resolve(0),
  });
  const init = manifest.commands.find((c) => c.command === "init");
  assertEquals(init?.usage, "pb init [<version>] [--dir <d>] [--force]");
  assertEquals(init?.args[0].name, "version");
  assertEquals(init?.args[0].required, false);
  const install = manifest.commands.find((c) => c.command === "install");
  assertEquals(install?.flags.some((f) => f.name === "os"), true);
  assertEquals(install?.flags.some((f) => f.name === "arch"), true);
  const versions = manifest.commands.find((c) => c.command === "versions");
  assertEquals(versions?.flags.some((f) => f.name === "all"), true);
  assertEquals(versions?.flags.some((f) => f.name === "pre"), true);
});

Deno.test("buildManifest omits args/flags for an unregistered command's spec", () => {
  const manifest = buildManifest({
    "totally-made-up": () => Promise.resolve(0),
  });
  const entry = manifest.commands.find((c) => c.command === "totally-made-up");
  assertEquals(entry?.usage, "Usage: pb totally-made-up");
  assertEquals(entry?.args, []);
  assertEquals(entry?.flags, []);
});
