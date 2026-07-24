import { assertEquals } from "@std/assert";
import { dispatch, parseGlobal } from "../../src/router.ts";
import type { CommandSpec } from "../../src/usage.ts";
import type { PromptIO } from "../../src/ui/prompt.ts";

function fakeIO(inputs: string[]): PromptIO {
  const q = [...inputs];
  return {
    read: () => Promise.resolve(q.shift() ?? null),
    write: () => {},
    isTTY: true,
  };
}

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

const REQUIRED_FLAG_SPEC: CommandSpec = {
  usage: "pb thing do --name <n> --runtime <deno|bun>",
  summary: "",
  args: [],
  flags: [
    { name: "name", type: "string", required: true },
    {
      name: "runtime",
      type: "string",
      required: true,
      choices: ["deno", "bun"],
    },
  ],
};

Deno.test("-i prompts for a missing required flag and injects it into ctx.raw", async () => {
  let seen: Record<string, unknown> = {};
  const code = await dispatch(
    {
      "thing do": (ctx) => {
        seen = ctx.raw;
        return Promise.resolve(0);
      },
    },
    ["thing", "do", "--runtime", "deno", "-i"],
    { "thing do": REQUIRED_FLAG_SPEC },
    fakeIO(["mybox"]),
  );
  assertEquals(code, 0);
  assertEquals(seen.name, "mybox");
});

Deno.test("-i uses a select menu for a required flag with choices", async () => {
  let runtime: unknown;
  const code = await dispatch(
    {
      "thing do": (ctx) => {
        runtime = ctx.raw.runtime;
        return Promise.resolve(0);
      },
    },
    ["thing", "do", "--name", "x", "-i"],
    { "thing do": REQUIRED_FLAG_SPEC },
    fakeIO(["2"]), // second choice → "bun"
  );
  assertEquals(code, 0);
  assertEquals(runtime, "bun");
});

Deno.test("-i prompts for a missing required positional and injects it into ctx.args", async () => {
  let args: string[] = [];
  const code = await dispatch(
    {
      "thing name": (ctx) => {
        args = ctx.args;
        return Promise.resolve(0);
      },
    },
    ["thing", "name", "-i"],
    {
      "thing name": {
        usage: "pb thing name <name>",
        summary: "",
        args: [{ name: "name", required: true }],
        flags: [],
      },
    },
    fakeIO(["chosen"]),
  );
  assertEquals(code, 0);
  assertEquals(args[0], "chosen");
});

Deno.test("-i does not re-prompt a value already supplied", async () => {
  let seen: unknown;
  const throwIO: PromptIO = {
    read: () => {
      throw new Error("should not read");
    },
    write: () => {},
    isTTY: true,
  };
  const code = await dispatch(
    {
      "thing solo": (ctx) => {
        seen = ctx.raw.name;
        return Promise.resolve(0);
      },
    },
    ["thing", "solo", "--name", "given", "-i"],
    {
      "thing solo": {
        usage: "pb thing solo --name <n>",
        summary: "",
        args: [],
        flags: [{ name: "name", type: "string", required: true }],
      },
    },
    throwIO,
  );
  assertEquals(code, 0);
  assertEquals(seen, "given");
});

Deno.test("--interactive with --no-input errors and skips the handler", async () => {
  let hit = false;
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (s: string) => errs.push(s);
  let code: number;
  try {
    code = await dispatch(
      {
        "thing solo": () => {
          hit = true;
          return Promise.resolve(0);
        },
      },
      ["thing", "solo", "-i", "--no-input"],
      { "thing solo": REQUIRED_FLAG_SPEC },
    );
  } finally {
    console.error = origErr;
  }
  assertEquals(code, 2);
  assertEquals(hit, false);
});
