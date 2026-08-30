import { assertEquals, assertMatch } from "@std/assert";
import { VERSION } from "../../src/version.ts";
import { run } from "../../main.ts";

Deno.test("VERSION is a semver MAJOR.MINOR.PATCH string", () => {
  assertMatch(VERSION, /^\d+\.\d+\.\d+$/);
});

Deno.test("run --version prints exactly `pbc ${VERSION}`", async () => {
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
  assertEquals(logs[0], `pbc ${VERSION}`);
});

Deno.test("a flag before the command is a usage error, not a silent root help", async () => {
  const errs: string[] = [];
  const logs: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (s: string) => errs.push(s);
  console.log = (s: string) => logs.push(s);
  let code: number;
  try {
    code = await run(["--json", "cloud", "pb", "ls"]);
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  assertEquals(code, 2);
  assertEquals(errs[0].includes("`pbc cloud pb ls --json`"), true);
  const envelope = JSON.parse(logs[0]);
  assertEquals(envelope.ok, false);
  assertEquals(envelope.error.code, "USAGE");
});

Deno.test("a bare global flag still reaches its own fast path", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (s: string) => logs.push(s);
  let help: number, manifest: number;
  try {
    help = await run(["--help"]);
    manifest = await run(["--json"]);
  } finally {
    console.log = orig;
  }
  assertEquals(help, 0);
  assertEquals(manifest, 0);
  assertEquals(logs[0].startsWith("pbc — PocketBase Cloud CLI"), true);
  assertEquals(typeof JSON.parse(logs[1]).data.commands, "object");
});
