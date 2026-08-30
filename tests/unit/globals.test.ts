import { assertEquals } from "@std/assert";
import {
  GLOBAL_FLAGS,
  GLOBAL_FLAG_NAMES,
  commandPathOf,
  parseGlobalFlags,
  splitPathAndFlags,
} from "../../src/globals.ts";

Deno.test("GLOBAL_FLAGS covers every global including interactive and version", () => {
  const names = GLOBAL_FLAGS.map((f) => f.name).sort();
  assertEquals(names, [
    "help", "interactive", "json", "no-input", "profile", "project",
    "version", "yes",
  ]);
});

Deno.test("the collision guard set is derived from the flags object", () => {
  assertEquals(GLOBAL_FLAG_NAMES.has("interactive"), true);
  assertEquals(GLOBAL_FLAG_NAMES.has("json"), true);
  assertEquals(GLOBAL_FLAG_NAMES.has("name"), false);
});

Deno.test("parseGlobalFlags reads globals and short forms", () => {
  assertEquals(parseGlobalFlags(["--json", "--project", "p1"]), {
    json: true, yes: false, noInput: false, interactive: false,
    project: "p1",
  });
  assertEquals(parseGlobalFlags(["-y"]).yes, true);
  assertEquals(parseGlobalFlags(["-i"]).interactive, true);
  assertEquals(parseGlobalFlags(["-v"]).version, true);
  assertEquals(parseGlobalFlags(["-h"]).help, true);
  assertEquals(parseGlobalFlags(["--project=p1"]).project, "p1");
  assertEquals(parseGlobalFlags(["--json=false"]).json, false);
});

Deno.test("parseGlobalFlags never mistakes a flag value for the --json flag", () => {
  assertEquals(parseGlobalFlags(["--data=--json"]).json, false);
  assertEquals(parseGlobalFlags(["--data", "--json"]).json, true);
});

Deno.test("parseGlobalFlags stops scanning at --", () => {
  assertEquals(parseGlobalFlags(["--json", "--", "--no-input"]), {
    json: true, yes: false, noInput: false, interactive: false,
  });
});

Deno.test("commandPathOf extracts the command even when globals precede it", () => {
  assertEquals(commandPathOf(["upgrade"]), ["upgrade"]);
  assertEquals(commandPathOf(["--profile", "x", "upgrade"]), ["upgrade"]);
  assertEquals(commandPathOf(["--project", "p1", "cloud", "pb", "ls", "--json"]), [
    "cloud", "pb", "ls",
  ]);
  assertEquals(commandPathOf(["--data", "api", "cloud"]), ["cloud"]);
  assertEquals(commandPathOf(["-y", "upgrade"]), ["upgrade"]);
});

Deno.test("splitPathAndFlags rewrites a misordered invocation", () => {
  const { path, flags } = splitPathAndFlags(
    ["--project", "p1", "cloud", "pb", "ls", "--json"],
  );
  assertEquals(path, ["cloud", "pb", "ls"]);
  assertEquals(flags, ["--project", "p1", "--json"]);
  assertEquals([...path, ...flags], [
    "cloud", "pb", "ls", "--project", "p1", "--json",
  ]);
  assertEquals(splitPathAndFlags(["cloud", "pb", "ls", "-y"]), {
    path: ["cloud", "pb", "ls"],
    flags: ["-y"],
  });
  assertEquals(splitPathAndFlags(["--json"]), { path: [], flags: ["--json"] });
  assertEquals(splitPathAndFlags(["-y", "--", "cloud"]), {
    path: [],
    flags: ["-y", "--", "cloud"],
  });
});

Deno.test("a boolean global consumes nothing in the pre-registry scan", () => {
  assertEquals(commandPathOf(["--json", "cloud", "pb", "ls"]), [
    "cloud", "pb", "ls",
  ]);
  assertEquals(commandPathOf(["--no-input", "upgrade"]), ["upgrade"]);
  assertEquals(commandPathOf(["--interactive", "cloud", "env", "set"]), [
    "cloud", "env", "set",
  ]);
});
