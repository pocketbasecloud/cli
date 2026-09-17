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

Deno.test("long-form command documentation keeps the facts, not the length", () => {
  const details = (command: string) => COMMANDS[command].details ?? "";

  const ladder = details("deploy");
  for (const step of ["  1.", "  2.", "  3.", "  4.", "  5.", "  6.", "  7."]) {
    if (!ladder.includes(step)) {
      throw new Error(`deploy details lost detection step ${step.trim()}`);
    }
  }
  if (!ladder.includes("printed before the deploy")) {
    throw new Error("deploy details lost the visible-guess note");
  }
  if (!ladder.includes("--delete-missing") || !ladder.includes("--force-env")) {
    throw new Error("deploy details lost the env-push rules");
  }

  const pb = details("pocketbase deploy");
  for (const fact of ["pb_public", "pb_hooks", "pb_migrations", "superuser"]) {
    if (!pb.includes(fact)) {
      throw new Error(`pocketbase deploy details lost "${fact}"`);
    }
  }
  if (!details("pocketbase create").includes("--backup")) {
    throw new Error("pocketbase create details lost the backup restore path");
  }

  const frontend = details("frontend deploy");
  for (const fact of ["build", "no cloud env store", "domain"]) {
    if (!frontend.includes(fact)) {
      throw new Error(`frontend deploy details lost "${fact}"`);
    }
  }

  const backend = details("backend deploy");
  for (const fact of ["nextjs", "standalone", "node_modules"]) {
    if (!backend.includes(fact)) {
      throw new Error(`backend deploy details lost "${fact}"`);
    }
  }
});
