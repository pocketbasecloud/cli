import { assertEquals } from "@std/assert";
import {
  str,
  type Command,
  type CommandRegistry,
} from "../../src/command.ts";
import { dispatch, nearestCommand } from "../../src/router.ts";
import { parseGlobalFlags } from "../../src/globals.ts";
import { resolveCommand } from "../../src/parse.ts";
import type { PromptIO } from "../../src/ui/prompt.ts";

function fakeIO(inputs: string[]): PromptIO {
  const q = [...inputs];
  return {
    read: () => Promise.resolve(q.shift() ?? null),
    write: () => {},
    isTTY: true,
  };
}

function cmd(
  path: string[],
  def: {
    usage?: string;
    summary?: string;
    args?: Command["args"];
    flags?: Command["flags"];
  } = {},
  run?: Command["run"],
): Command {
  return {
    path,
    usage: def.usage ?? `pbc ${path.join(" ")}`,
    summary: def.summary ?? "",
    args: def.args ?? [],
    flags: def.flags ?? {},
    run: run ?? (() => Promise.resolve(0)),
  } as Command;
}

const REGISTRY: CommandRegistry = { "cloud pb ls": cmd(["cloud", "pb", "ls"]) };

Deno.test("resolveCommand separates path from flags", () => {
  const r = resolveCommand(["cloud", "pb", "ls", "--json", "--project", "p1"], REGISTRY);
  assertEquals(r.path, ["cloud", "pb", "ls"]);
  assertEquals(r.command?.path, ["cloud", "pb", "ls"]);
  assertEquals(r.rest, ["--json", "--project", "p1"]);
  assertEquals(r.args, []);
  const globals = parseGlobalFlags(r.rest);
  assertEquals(globals.json, true);
  assertEquals(globals.project, "p1");
});

Deno.test("a flag before the command path is now a usage error", () => {
  const r = resolveCommand(["--json", "cloud", "pb", "ls"], REGISTRY);
  assertEquals(r.path, []);
  assertEquals(r.command, undefined);
  assertEquals(r.rest, ["--json", "cloud", "pb", "ls"]);
});

Deno.test("dispatch routes to longest matching command", async () => {
  let hit = "";
  const code = await dispatch({
    "cloud pb ls": cmd(["cloud", "pb", "ls"], {}, () => {
      hit = "ls";
      return Promise.resolve(0);
    }),
  }, ["cloud", "pb", "ls"]);
  assertEquals(code, 0);
  assertEquals(hit, "ls");
});

Deno.test("dispatch returns 2 and a message for unknown command", async () => {
  const code = await dispatch({}, ["nope"]);
  assertEquals(code, 2);
});

Deno.test("dispatch prints prose usage and skips the handler when --help is passed", async () => {
  let hit = false;
  const code = await dispatch({
    "cloud pb ls": cmd(
      ["cloud", "pb", "ls"],
      {
        usage: "pbc cloud pb ls [--project <id>]",
        summary: "List PocketBase instances in a project.",
      },
      () => {
        hit = true;
        return Promise.resolve(0);
      },
    ),
  }, ["cloud", "pb", "ls", "--help"]);
  assertEquals(code, 0);
  assertEquals(hit, false);
});

Deno.test("dispatch prints the command's JSON spec when --help --json is passed", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => logs.push(s);
  try {
    const code = await dispatch({
      "cloud pb ls": cmd(["cloud", "pb", "ls"], {
        usage: "pbc cloud pb ls [--project <id>]",
        summary: "List PocketBase instances in a project.",
      }),
    }, ["cloud", "pb", "ls", "--help", "--json"]);
    assertEquals(code, 0);
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.data.usage, "pbc cloud pb ls [--project <id>]");
  assertEquals(
    parsed.data.summary,
    "List PocketBase instances in a project.",
  );
});

Deno.test("dispatch handles -h with the declared usage", async () => {
  const code = await dispatch({ "cloud pb ls": cmd(["cloud", "pb", "ls"]) }, [
    "cloud",
    "pb",
    "ls",
    "-h",
  ]);
  assertEquals(code, 0);
});

const THING_DO_FLAGS: Command["flags"] = {
  name: str({ description: "", required: true }),
  runtime: str({ description: "", required: true, choices: ["deno", "bun"] }),
};

const THING_SOLO_FLAGS: Command["flags"] = {
  name: str({ description: "", required: true }),
};

Deno.test("-i prompts for a missing required flag and injects it into input", async () => {
  let seen: Record<string, unknown> = {};
  const code = await dispatch({
    "thing do": cmd(["thing", "do"], { flags: THING_DO_FLAGS }, (input) => {
      seen = input;
      return Promise.resolve(0);
    }),
  }, ["thing", "do", "--runtime", "deno", "-i"], fakeIO(["mybox"]));
  assertEquals(code, 0);
  assertEquals(seen.name, "mybox");
});

Deno.test("-i uses a select menu for a required flag with choices", async () => {
  let runtime: unknown;
  const code = await dispatch({
    "thing do": cmd(["thing", "do"], { flags: THING_DO_FLAGS }, (input) => {
      runtime = input.runtime;
      return Promise.resolve(0);
    }),
  }, ["thing", "do", "--name", "x", "-i"], fakeIO(["2"]));
  assertEquals(code, 0);
  assertEquals(runtime, "bun");
});

Deno.test("-i prompts for a missing required positional and injects it into ctx.args", async () => {
  let args: string[] = [];
  const code = await dispatch({
    "thing name": cmd(
      ["thing", "name"],
      { args: [{ name: "name", required: true }] },
      (_input, ctx) => {
        args = ctx.args;
        return Promise.resolve(0);
      },
    ),
  }, ["thing", "name", "-i"], fakeIO(["chosen"]));
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
  const code = await dispatch({
    "thing solo": cmd(["thing", "solo"], { flags: THING_SOLO_FLAGS }, (input) => {
      seen = input.name;
      return Promise.resolve(0);
    }),
  }, ["thing", "solo", "--name", "given", "-i"], throwIO);
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
    code = await dispatch({
      "thing solo": cmd(
        ["thing", "solo"],
        { flags: THING_DO_FLAGS },
        () => {
          hit = true;
          return Promise.resolve(0);
        },
      ),
    }, ["thing", "solo", "-i", "--no-input"]);
  } finally {
    console.error = origErr;
  }
  assertEquals(code, 2);
  assertEquals(hit, false);
});

const REGISTRY_KEYS = [
  "cloud pb ls",
  "cloud pb deploy",
  "cloud pb rm",
  "cloud project ls",
  "cloud frontend deploy",
  "cloud frontend ls",
];

Deno.test("nearestCommand suggests the closest key for a synonym", () => {
  assertEquals(nearestCommand("cloud pb list", REGISTRY_KEYS), "cloud pb ls");
  assertEquals(
    nearestCommand("cloud pb delete", REGISTRY_KEYS),
    "cloud pb deploy",
  );
});

Deno.test("nearestCommand suggests the closest key for a typo", () => {
  assertEquals(
    nearestCommand("cloud porject ls", REGISTRY_KEYS),
    "cloud project ls",
  );
  assertEquals(
    nearestCommand("cloud frontend deploj", REGISTRY_KEYS),
    "cloud frontend deploy",
  );
});

Deno.test("nearestCommand returns null when nothing is close", () => {
  assertEquals(nearestCommand("wibble", REGISTRY_KEYS), null);
  assertEquals(nearestCommand("", REGISTRY_KEYS), null);
});

Deno.test("dispatch prints a suggestion for an unknown command", async () => {
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (s: string) => errs.push(s);
  let code: number;
  try {
    code = await dispatch({ "cloud pb ls": cmd(["cloud", "pb", "ls"]) }, [
      "cloud",
      "pb",
      "list",
    ]);
  } finally {
    console.error = origErr;
  }
  assertEquals(code, 2);
  assertEquals(errs.length, 1);
  assertEquals(errs[0].includes("Did you mean `pbc cloud pb ls`?"), true);
});
