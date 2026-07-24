import { assertEquals, assertMatch } from "@std/assert";
import { VERSION } from "../../src/version.ts";
import { run } from "../../main.ts";

Deno.test("VERSION is a semver MAJOR.MINOR.PATCH string", () => {
  assertMatch(VERSION, /^\d+\.\d+\.\d+$/);
});

Deno.test("run --version prints exactly `pb ${VERSION}`", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (s: string) => logs.push(s);
  let code: number;
  try {
    code = await run(["--version"]);
  } finally {
    console.log = orig;
  }
  assertEquals(code, 0);
  assertEquals(logs[0], `pb ${VERSION}`);
});
