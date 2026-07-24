import { assertEquals } from "@std/assert";
import { run } from "../../main.ts";

Deno.test("run --version prints version and exits 0", async () => {
  const code = await run(["--version"]);
  assertEquals(code, 0);
});

Deno.test("run --help exits 0", async () => {
  const code = await run(["--help"]);
  assertEquals(code, 0);
});

Deno.test("run help exits 0", async () => {
  const code = await run(["help"]);
  assertEquals(code, 0);
});

Deno.test("--version after a command does not short-circuit dispatch", async () => {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (s: string) => logs.push(s);
  console.error = (s: string) => errs.push(s);
  let code: number;
  try {
    code = await run(["totally-unknown-cmd", "--version"]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assertEquals(code, 1);
  assertEquals(logs.some((l) => l.startsWith("pb 0.")), false);
  assertEquals(errs.some((e) => e.includes("Unknown command")), true);
});

Deno.test("run --help --json prints a valid manifest and exits 0", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => logs.push(s);
  let code: number;
  try {
    code = await run(["--help", "--json"]);
  } finally {
    console.log = origLog;
  }
  assertEquals(code, 0);
  const manifest = JSON.parse(logs[0]);
  assertEquals(Array.isArray(manifest.commands), true);
  assertEquals(Array.isArray(manifest.globalFlags), true);
  assertEquals(
    manifest.commands.some((c: { command: string }) =>
      c.command === "cloud org share"
    ),
    true,
  );
});
