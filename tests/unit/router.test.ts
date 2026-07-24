import { assertEquals } from "@std/assert";
import { dispatch, parseGlobal } from "../../src/router.ts";
import type { CommandSpec } from "../../src/usage.ts";

Deno.test("parseGlobal separates path from flags", () => {
  const { path, ctx } = parseGlobal([
    "cloud",
    "pb",
    "ls",
    "--json",
    "--project",
    "p1",
  ]);
  assertEquals(path, ["cloud", "pb", "ls"]);
  assertEquals(ctx.flags.json, true);
  assertEquals(ctx.flags.project, "p1");
});

Deno.test("dispatch routes to longest matching command", async () => {
  let hit = "";
  const code = await dispatch({
    "cloud pb ls": () => {
      hit = "ls";
      return Promise.resolve(0);
    },
  }, ["cloud", "pb", "ls"]);
  assertEquals(code, 0);
  assertEquals(hit, "ls");
});

Deno.test("dispatch returns 1 and message for unknown command", async () => {
  const code = await dispatch({}, ["nope"]);
  assertEquals(code, 1);
});

const SAMPLE_SPEC: CommandSpec = {
  usage: "pb cloud pb ls [--project <id>]",
  summary: "List PocketBase instances in a project.",
  args: [],
  flags: [],
};

Deno.test("dispatch prints prose usage and skips the handler when --help is passed", async () => {
  let hit = false;
  const code = await dispatch(
    {
      "cloud pb ls": () => {
        hit = true;
        return Promise.resolve(0);
      },
    },
    ["cloud", "pb", "ls", "--help"],
    { "cloud pb ls": SAMPLE_SPEC },
  );
  assertEquals(code, 0);
  assertEquals(hit, false);
});

Deno.test("dispatch prints the command's JSON spec when --help --json is passed", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => logs.push(s);
  try {
    const code = await dispatch(
      { "cloud pb ls": () => Promise.resolve(0) },
      ["cloud", "pb", "ls", "--help", "--json"],
      { "cloud pb ls": SAMPLE_SPEC },
    );
    assertEquals(code, 0);
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.command, "cloud pb ls");
  assertEquals(parsed.usage, SAMPLE_SPEC.usage);
  assertEquals(parsed.summary, SAMPLE_SPEC.summary);
});

Deno.test("dispatch falls back to a generic usage line when none is provided", async () => {
  const code = await dispatch(
    { "cloud pb ls": () => Promise.resolve(0) },
    ["cloud", "pb", "ls", "-h"],
  );
  assertEquals(code, 0);
});
