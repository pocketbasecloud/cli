import { assertEquals, assertRejects } from "@std/assert";
import {
  confirm,
  fillMissing,
  type PromptIO,
  select,
} from "../../src/ui/prompt.ts";
import { defineCommand, str, type Command } from "../../src/command.ts";
import type { ParseOutcome } from "../../src/parse.ts";

function fakeIO(inputs: string[]): PromptIO {
  const q = [...inputs];
  return {
    read: () => Promise.resolve(q.shift() ?? null),
    write: () => {},
    isTTY: true,
  };
}

Deno.test("confirm returns true immediately when yes flag set", async () => {
  const r = await confirm("Delete?", { noInput: true, yes: true });
  assertEquals(r, true);
});

Deno.test("confirm reads y/n", async () => {
  assertEquals(
    await confirm("ok?", { noInput: false, yes: false, io: fakeIO(["y"]) }),
    true,
  );
  assertEquals(
    await confirm("ok?", { noInput: false, yes: false, io: fakeIO(["n"]) }),
    false,
  );
});

Deno.test("confirm under no-input points at --yes, not --no-input", async () => {
  const err = await assertRejects(() =>
    confirm("Delete?", { noInput: true, yes: false })
  );
  assertEquals((err as Error).message.includes("--yes"), true);
  assertEquals((err as Error).message.includes("--no-input"), false);
});

Deno.test("confirm on a non-TTY points at --yes without prompting", async () => {
  const noTty: PromptIO = {
    read: () => {
      throw new Error("should not read");
    },
    write: () => {},
    isTTY: false,
  };
  const err = await assertRejects(() =>
    confirm("Delete?", { noInput: false, yes: false, io: noTty })
  );
  assertEquals((err as Error).message.includes("--yes"), true);
});

Deno.test("select picks by index", async () => {
  const r = await select("pick", ["a", "b", "c"], (x) => x, {
    noInput: false,
    io: fakeIO(["2"]),
  });
  assertEquals(r, "b");
});

Deno.test("select throws under no-input", async () => {
  await assertRejects(() => select("pick", ["a"], (x) => x, { noInput: true }));
});

const FILL_CMD: Command = defineCommand({
  path: ["thing", "fill"],
  usage: "",
  summary: "",
  args: [{ name: "target", required: true }],
  flags: {
    name: str({ description: "", required: true }),
    runtime: str({ description: "", required: true, choices: ["deno", "bun"] }),
    note: str({ description: "", required: false }),
  },
  run: () => Promise.resolve(0),
});

function okOutcome(args: string[] = []): Extract<ParseOutcome, { ok: true }> {
  return { ok: true, command: FILL_CMD, input: {}, passthrough: [], args };
}

Deno.test("fillMissing prompts positional, string, and choice fields", async () => {
  const outcome = okOutcome();
  await fillMissing(FILL_CMD, outcome, {
    noInput: false,
    io: fakeIO(["proj", "svc", "1"]),
  });
  assertEquals(outcome.args[0], "proj");
  assertEquals(outcome.input.name, "svc");
  assertEquals(outcome.input.runtime, "deno");
  assertEquals(outcome.input.note, undefined);
});

Deno.test("fillMissing leaves already-supplied values untouched", async () => {
  const outcome = okOutcome(["given-target"]);
  outcome.input.name = "given-name";
  outcome.input.runtime = "bun";
  const throwIO: PromptIO = {
    read: () => {
      throw new Error("should not read");
    },
    write: () => {},
    isTTY: true,
  };
  await fillMissing(FILL_CMD, outcome, { noInput: false, io: throwIO });
  assertEquals(outcome.args[0], "given-target");
  assertEquals(outcome.input.name, "given-name");
  assertEquals(outcome.input.runtime, "bun");
});

Deno.test("the commands that offer a picker still declare their flags required", async () => {
  const { COMMANDS } = await import("../../src/usage.ts");
  const expected: Record<string, string[]> = {
    "env import": ["target", "name"],
    "env ls": ["target", "name"],
    "env rm": ["target", "name"],
    "env set": ["target", "name"],
    "logs": ["name"],
    "frontend domain add": ["name"],
    "frontend domain remove": ["name"],
    "frontend domain verify": ["name"],
  };
  for (const [command, names] of Object.entries(expected)) {
    const spec = COMMANDS[command];
    if (!spec) throw new Error(`${command} is not in the manifest`);
    const required = spec.flags.filter((f) => f.required).map((f) => f.name);
    assertEquals(required.sort(), [...names].sort(), command);
  }
});
