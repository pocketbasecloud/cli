import { assertEquals } from "@std/assert";
import { deepEqual, isNoOpWrite } from "../../src/unchanged.ts";

Deno.test("deepEqual compares parsed JSON structurally", () => {
  assertEquals(deepEqual(1, 1), true);
  assertEquals(deepEqual("a", "a"), true);
  assertEquals(deepEqual(null, null), true);
  assertEquals(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assertEquals(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }), true);

  assertEquals(deepEqual(1, "1"), false);
  assertEquals(deepEqual(null, {}), false);
  assertEquals(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assertEquals(deepEqual({ a: 1, b: 2 }, { a: 1 }), false);
  // Order is part of an array field's stored value.
  assertEquals(deepEqual([1, 2], [2, 1]), false);
  assertEquals(deepEqual([1], [1, 1]), false);
  assertEquals(deepEqual([], {}), false);
});

Deno.test("deepEqual does not confuse a missing key with an undefined one", () => {
  // Same key count, but `b` is absent rather than undefined — a write would
  // still be the safer read of this.
  assertEquals(
    deepEqual({ a: 1, b: undefined }, { a: 1, c: undefined }),
    false,
  );
});

Deno.test("isNoOpWrite is true only when every named field already matches", () => {
  const current = { id: "r1", title: "hi", tags: ["a"], meta: { n: 1 } };
  assertEquals(isNoOpWrite(current, { title: "hi" }), true);
  assertEquals(isNoOpWrite(current, { title: "hi", tags: ["a"] }), true);
  assertEquals(isNoOpWrite(current, { meta: { n: 1 } }), true);

  assertEquals(isNoOpWrite(current, { title: "bye" }), false);
  assertEquals(isNoOpWrite(current, { title: "hi", tags: ["b"] }), false);
  assertEquals(isNoOpWrite(current, { meta: { n: 2 } }), false);
});

Deno.test("isNoOpWrite falls open to writing whenever it cannot tell", () => {
  // A field the instance does not report — write-only, or masked.
  assertEquals(isNoOpWrite({ id: "r1" }, { password: "s3cret" }), false);
  // Nothing was read.
  assertEquals(isNoOpWrite(undefined, { title: "hi" }), false);
  // An empty body is not a claim that anything matched.
  assertEquals(isNoOpWrite({ id: "r1", title: "hi" }, {}), false);
});
