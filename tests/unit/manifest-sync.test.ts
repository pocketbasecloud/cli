import { assertEquals } from "@std/assert";
import { COMMANDS } from "../../src/usage.ts";
import type { CommandRegistry } from "../../src/command.ts";
import { commandSpecs } from "../../scripts/gen-manifest.ts";

Deno.test("src/usage.ts is generated from the registry and cannot drift", async () => {
  const registry: CommandRegistry = {};
  const { registerCommands } = await import("../../src/commands/index.ts");
  registerCommands(registry);
  assertEquals(
    commandSpecs(registry),
    COMMANDS,
    "src/usage.ts is stale — run `deno task manifest` to regenerate it.",
  );
});

Deno.test("an alias and a parse-and-discard flag are marked as such", () => {
  const deploy = COMMANDS["pocketbase deploy"];
  const server = deploy.flags.find((f) => f.name === "server");
  const subdomain = deploy.flags.find((f) => f.name === "subdomain");
  assertEquals(server?.renamedTo, "compute");
  assertEquals(typeof subdomain?.retired?.since, "string");
  assertEquals(deploy.flags.find((f) => f.name === "compute")?.renamedTo, undefined);
});

Deno.test("long-form command documentation is not quietly summarised away", () => {
  const floors: Record<string, number> = {
    "deploy": 1200,
    "pocketbase deploy": 800,
    "frontend deploy": 800,
    "backend deploy": 800,
  };
  for (const [command, floor] of Object.entries(floors)) {
    const details = COMMANDS[command].details ?? "";
    if (details.length < floor) {
      throw new Error(
        `${command} details is ${details.length} chars, under the ${floor} floor`,
      );
    }
  }
  const ladder = COMMANDS["deploy"].details ?? "";
  for (const step of ["  1.", "  2.", "  3.", "  4.", "  5.", "  6.", "  7."]) {
    if (!ladder.includes(step)) {
      throw new Error(`deploy details lost detection step ${step.trim()}`);
    }
  }
  if (!ladder.includes("printed before the deploy")) {
    throw new Error("deploy details lost the visible-guess note");
  }
});
