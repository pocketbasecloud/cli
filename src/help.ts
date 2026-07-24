import type { Handler } from "./router.ts";
import { COMMANDS, type CommandSpec, type FlagSpec } from "./usage.ts";

const GLOBAL_FLAGS: FlagSpec[] = [
  {
    name: "json",
    type: "boolean",
    required: false,
    description: "Output machine-readable JSON",
  },
  {
    name: "yes",
    type: "boolean",
    required: false,
    description: "Skip confirmation prompts (-y)",
  },
  {
    name: "no-input",
    type: "boolean",
    required: false,
    description: "Fail instead of prompting",
  },
  {
    name: "interactive",
    type: "boolean",
    required: false,
    description: "Prompt for missing required values instead of erroring (-i)",
  },
  {
    name: "project",
    type: "string",
    required: false,
    description: "Which cloud project a `cloud ...` command targets",
  },
  {
    name: "profile",
    type: "string",
    required: false,
    description: "Which saved instance login a non-cloud command targets",
  },
  {
    name: "version",
    type: "boolean",
    required: false,
    description: "Print version (-v)",
  },
  {
    name: "help",
    type: "boolean",
    required: false,
    description: "Show help (-h)",
  },
];

const EMPTY_SPEC: CommandSpec = { usage: "", summary: "", args: [], flags: [] };

/** Commands that act on this machine rather than on a PocketBase instance. */
export const LOCAL_COMMANDS = new Set(["init", "install", "versions", "which"]);

function specFor(key: string): CommandSpec {
  return COMMANDS[key] ?? { ...EMPTY_SPEC, usage: `Usage: pb ${key}` };
}

function formatSection(commands: string[]): string[] {
  const width = Math.max(0, ...commands.map((c) => c.length));
  return commands.map((c) => {
    const desc = COMMANDS[c]?.summary ?? "";
    if (!desc) return `  ${c}`;
    return `  ${c}${" ".repeat(width - c.length)}  ${desc}`;
  });
}

export function buildHelpText(registry: Record<string, Handler>): string {
  const commands = Object.keys(registry).sort();
  const cloud = commands.filter((c) => c.startsWith("cloud "));
  const local = commands.filter((c) => LOCAL_COMMANDS.has(c));
  const instance = commands.filter(
    (c) => !c.startsWith("cloud ") && !LOCAL_COMMANDS.has(c),
  );

  return [
    "pb — PocketBase Cloud CLI",
    "",
    "Usage: pb <command> [args] [flags]",
    "",
    "Global flags:",
    "  --json             Output machine-readable JSON",
    "  --yes, -y          Skip confirmation prompts",
    "  --no-input         Fail instead of prompting",
    "  --interactive, -i  Prompt for missing required values instead of erroring",
    "  --project <id>     Which cloud project a `cloud ...` command targets",
    "                     (defaults to the linked/`use`d project)",
    "  --profile <name>   Which saved instance login (from `pb use <url>`)",
    "                     a non-cloud command targets",
    "  --version, -v      Print version",
    "  --help, -h         Show this help",
    "",
    ...(local.length > 0
      ? [
        "Local commands (a PocketBase binary on this machine):",
        ...formatSection(local),
        "",
      ]
      : []),
    "Instance commands (a specific PocketBase instance, via `pb use <url>`):",
    ...formatSection(instance),
    "",
    "Cloud commands (your PocketBase Cloud account):",
    ...formatSection(cloud),
    "",
    "Run `pb <command> --help` for details on a specific command.",
  ].join("\n");
}

export function buildManifest(
  registry: Record<string, Handler>,
): {
  globalFlags: FlagSpec[];
  commands: (CommandSpec & { command: string })[];
} {
  return {
    globalFlags: GLOBAL_FLAGS,
    commands: Object.keys(registry).sort().map((command) => ({
      command,
      ...specFor(command),
    })),
  };
}
