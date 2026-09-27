import type { ArgSpec, Command, CommandRegistry } from "./command.ts";
import { canonicalKeys, kebabCase } from "./command.ts";
import { GLOBAL_FLAGS } from "./globals.ts";
import { manifestEntry, type ManifestEntry } from "./router.ts";

export const CLOUD_FAMILIES = new Set([
  "pocketbase", "frontend", "backend", "env", "environments", "locations",
  "project", "compute", "server", "deploy", "init", "plan", "cloud",
  "logs", "ci", "login", "logout", "whoami", "self-driving",
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

function flagLines(command: Command): string[] {
  const live = Object.entries(command.flags).filter(([, f]) =>
    !f.renamedTo && !f.retired
  );
  const labels = live.map(([key, f]) =>
    `--${kebabCase(key)}${f.type === "boolean" ? "" : " <value>"}` +
    (f.short ? `, -${f.short}` : "")
  );
  const width = Math.max(0, ...labels.map((l) => l.length));
  return live.map(([, f], i) =>
    `  ${labels[i].padEnd(width)}  ${f.description}`.trimEnd()
  );
}

export function buildCommandHelpText(command: Command): string {
  const flags = flagLines(command);
  return [
    command.usage,
    command.summary,
    command.details,
    flags.length > 0 ? ["Flags:", ...flags].join("\n") : undefined,
  ].filter(Boolean).join("\n\n");
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
    "Cloud commands (your PocketBase Cloud account):",
    ...formatSection(registry, cloud),
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
