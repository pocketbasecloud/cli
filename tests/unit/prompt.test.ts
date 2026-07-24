import { assertEquals, assertRejects } from "@std/assert";
import {
  confirm,
  fillMissingFromSpec,
  type PromptIO,
  select,
} from "../../src/ui/prompt.ts";
import type { CommandSpec } from "../../src/usage.ts";

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

const FILL_SPEC: CommandSpec = {
  usage: "",
  summary: "",
  args: [{ name: "target", required: true }],
  flags: [
    { name: "name", type: "string", required: true },
    {
      name: "runtime",
      type: "string",
      required: true,
      choices: ["deno", "bun"],
    },
    { name: "note", type: "string", required: false },
  ],
};

Deno.test("fillMissingFromSpec prompts positional, string, and choice fields", async () => {
  const ctx = { args: [] as string[], raw: {} as Record<string, unknown> };
  // order: positional "target", then flag "name" (text), then "runtime" (select)
  await fillMissingFromSpec(FILL_SPEC, ctx, {
    noInput: false,
    io: fakeIO(["proj", "svc", "1"]),
  });
  assertEquals(ctx.args[0], "proj");
  assertEquals(ctx.raw.name, "svc");
  assertEquals(ctx.raw.runtime, "deno");
  assertEquals(ctx.raw.note, undefined); // optional, never prompted
});

Deno.test("fillMissingFromSpec leaves already-supplied values untouched", async () => {
  const ctx = {
    args: ["given-target"],
    raw: { name: "given-name", runtime: "bun" } as Record<string, unknown>,
  };
  const throwIO: PromptIO = {
    read: () => {
      throw new Error("should not read");
    },
    write: () => {},
    isTTY: true,
  };
  await fillMissingFromSpec(FILL_SPEC, ctx, { noInput: false, io: throwIO });
  assertEquals(ctx.args[0], "given-target");
  assertEquals(ctx.raw.name, "given-name");
  assertEquals(ctx.raw.runtime, "bun");
});
