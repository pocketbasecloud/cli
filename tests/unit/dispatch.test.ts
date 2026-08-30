import { assertEquals } from "@std/assert";
import { dispatch } from "../../src/router.ts";
import { defineCommand, str, bool } from "../../src/command.ts";
import type { CommandRegistry } from "../../src/command.ts";

const registry: CommandRegistry = {
  "thing do": defineCommand({
    path: ["thing", "do"],
    usage: "pbc thing do",
    summary: "Do a thing.",
    args: [],
    targets: [],
    flags: {
      name: str({ description: "n", required: true }),
      follow: bool({ description: "f", short: "f" }),
    },
    run: (input) => Promise.resolve(input.follow ? 0 : 1),
  }),
};

function capturedError(
  fn: () => Promise<number>,
): Promise<{ code: number; errs: string[] }> {
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (s: string) => errs.push(s);
  return fn().then((code) => ({ code, errs })).finally(() => {
    console.error = origErr;
  });
}

Deno.test("a typo'd flag exits 2 and performs no work", async () => {
  let hit = false;
  const { code, errs } = await capturedError(() => dispatch({
    ...registry,
    "thing do": defineCommand({
      path: ["thing", "do"], usage: "", summary: "", args: [], flags: {},
      run: () => { hit = true; return Promise.resolve(0); },
    }),
  }, ["thing", "do", "--nome", "x"]));
  assertEquals(code, 2);
  assertEquals(hit, false);
  assertEquals(errs[0].includes("unknown flag --nome"), true);
});

Deno.test("-f means --follow only where follow is declared", async () => {
  const ok = await dispatch(registry, ["thing", "do", "-f"]);
  assertEquals(ok, 0);
  const { code } = await capturedError(() => dispatch({
    "thing": defineCommand({
      path: ["thing"], usage: "", summary: "", args: [], flags: {},
      run: () => Promise.resolve(0),
    }),
  }, ["thing", "-f"]));
  assertEquals(code, 2);
});

Deno.test("--interactive still prompts for a missing required flag", async () => {
  const io = { read: () => Promise.resolve("typed"), write: () => {}, isTTY: true };
  const seen: Record<string, unknown> = {};
  const code = await dispatch({
    "thing do": defineCommand({
      path: ["thing", "do"], usage: "", summary: "", args: [],
      flags: { name: str({ description: "n", required: true }) },
      run: (input) => { seen.name = input.name; return Promise.resolve(0); },
    }),
  }, ["thing", "do", "-i"], io);
  assertEquals(code, 0);
  assertEquals(seen.name, "typed");
});

Deno.test("help and manifest render from the registry", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => logs.push(s);
  try {
    const code = await dispatch(registry, ["thing", "do", "--help", "--json"]);
    assertEquals(code, 0);
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.data.usage, "pbc thing do");
  assertEquals(parsed.data.summary, "Do a thing.");
});

Deno.test("no registered command shadows a global flag", async () => {
  const registry: CommandRegistry = {};
  const { registerCommands } = await import("../../src/commands/index.ts");
  registerCommands(registry);
  const { GLOBAL_FLAG_NAMES } = await import("../../src/globals.ts");

  for (const [key, command] of Object.entries(registry)) {
    for (const prop of Object.keys(command.flags)) {
      const kebab = prop.replace(/([A-Z])/g, "-$1").toLowerCase();
      if (GLOBAL_FLAG_NAMES.has(prop) || GLOBAL_FLAG_NAMES.has(kebab)) {
        throw new Error(`${key} shadows global flag --${prop}`);
      }
    }
  }
});
