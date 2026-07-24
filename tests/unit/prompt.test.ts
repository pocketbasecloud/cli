import { assertEquals, assertRejects } from "@std/assert";
import { confirm, type PromptIO, select } from "../../src/ui/prompt.ts";

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
