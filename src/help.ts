import type { ArgSpec, CommandRegistry } from "./command.ts";
import { canonicalKeys } from "./command.ts";
import { GLOBAL_FLAGS } from "./globals.ts";
import { manifestEntry, type ManifestEntry } from "./router.ts";

export const CLOUD_FAMILIES = new Set([
  "pocketbase", "frontend", "backend", "env", "environments", "locations",
  "project", "compute", "server", "deploy", "init", "plan", "cloud",
  "logs", "ci", "login", "logout", "whoami",
]);
export const LOCAL_FAMILIES = new Set(["local", "self"]);

function familyOf(command: string): "cloud" | "local" | "instance" {
  const root = command.split(" ")[0];
  if (CLOUD_FAMILIES.has(root)) return "cloud";
  if (LOCAL_FAMILIES.has(root)) return "local";
  return "instance";
}

function specFor(registry: CommandRegistry, key: string): ManifestEntry {
  const cmd = registry[key];
  return cmd
    ? manifestEntry(cmd)
    : {
      usage: `Usage: pbc ${key}`,
      summary: "",
      args: [] as ArgSpec[],
      flags: [],
      targets: [],
    };
}

function formatSection(registry: CommandRegistry, commands: string[]): string[] {
  const width = Math.max(0, ...commands.map((c) => c.length));
  return commands.map((c) => {
    const desc = registry[c]?.summary ?? "";
    return `  ${c}${" ".repeat(width - c.length)}  ${desc}`.trimEnd();
  });
}

export function buildHelpText(registry: CommandRegistry): string {
  const commands = canonicalKeys(registry).sort();
  const cloud = commands.filter((c) => familyOf(c) === "cloud");
  const local = commands.filter((c) => familyOf(c) === "local");
  const instance = commands.filter((c) => familyOf(c) === "instance");

  return [
    "pbc — PocketBase Cloud CLI",
    "",
    "Usage: pbc <command> [args] [flags]",
    "",
    "Global flags:",
    "  --json             Output machine-readable JSON",
    "  --yes, -y          Skip confirmation prompts",
    "  --no-input         Fail instead of prompting",
    "  --interactive, -i  Prompt for missing required values instead of erroring",
    "  --project <id>     Narrow which project's resources are considered when",
    "                     resolving a target (defaults to the linked/`use`d project)",
    "  --profile <name>   Which saved instance login a command that targets an",
    "                     instance uses (from `pbc admin use <url>`)",
    "  --version, -v      Print version",
    "  --help, -h         Show this help",
    "",
    ...(local.length > 0
      ? [
        "Local commands (pbc itself, and a PocketBase binary on this machine):",
        ...formatSection(registry, local),
        "",
      ]
      : []),
    "Instance commands (a specific PocketBase instance, via `pbc admin use <url>`):",
    ...formatSection(registry, instance),
    "",
    "Cloud commands (your PocketBase Cloud account):",
    ...formatSection(registry, cloud),
    "",
    "Run `pbc <command> --help` for details on a specific command.",
  ].join("\n");
}

export function buildManifest(
  registry: CommandRegistry,
): {
  globalFlags: (typeof GLOBAL_FLAGS)[number][];
  commands: (ManifestEntry & { command: string })[];
} {
  return {
    globalFlags: GLOBAL_FLAGS,
    commands: canonicalKeys(registry).sort().map((command) => ({
      command,
      ...specFor(registry, command),
    })),
  };
}
