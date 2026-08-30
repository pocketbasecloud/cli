import type { FlagSpec } from "./command.ts";
import { kebabCase } from "./command.ts";

const GLOBALS = {
  json: { type: "boolean", description: "Output machine-readable JSON" },
  yes: { type: "boolean", description: "Skip confirmation prompts", short: "y" },
  noInput: { type: "boolean", description: "Fail instead of prompting" },
  interactive: {
    type: "boolean",
    description: "Prompt for missing required values instead of erroring",
    short: "i",
  },
  project: {
    type: "string",
    description:
      "Narrow which project's resources are considered when resolving a target",
  },
  profile: {
    type: "string",
    description: "Which saved instance login a command that targets an instance uses",
  },
  version: { type: "boolean", description: "Print version", short: "v" },
  help: { type: "boolean", description: "Show help", short: "h" },
} as const satisfies Record<string, FlagSpec>;

export const GLOBAL_FLAGS: (FlagSpec & { name: string })[] =
  Object.entries(GLOBALS).map(([key, f]) => ({ ...f, name: kebabCase(key) }));
export const GLOBAL_FLAG_NAMES = new Set(GLOBAL_FLAGS.map((f) => f.name));

export type GlobalFlags = {
  json: boolean;
  yes: boolean;
  noInput: boolean;
  interactive: boolean;
  help?: boolean;
  version?: boolean;
  project?: string;
  profile?: string;
};

const BOOLEANS = new Set(
  GLOBAL_FLAGS.filter((f) => f.type === "boolean").map((f) => f.name),
);
const SHORTS = new Map(
  GLOBAL_FLAGS.filter((f) => f.short).map((f) => [f.short!, f.name]),
);

export function parseGlobalFlags(argv: string[]): GlobalFlags {
  const out: GlobalFlags = {
    json: false, yes: false, noInput: false, interactive: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") break;
    if (!tok.startsWith("-")) continue;
    const long = tok.startsWith("--");
    const eq = tok.indexOf("=");
    const rawName = long
      ? tok.slice(2, eq === -1 ? tok.length : eq)
      : tok.slice(1, eq === -1 ? tok.length : eq);
    const inline = eq === -1 ? undefined : tok.slice(eq + 1);
    const name = long ? rawName : (SHORTS.get(rawName) ?? rawName);
    if (BOOLEANS.has(name)) {
      (out as Record<string, unknown>)[name] =
        inline === undefined ? true : inline === "true";
      continue;
    }
    if (name === "project" || name === "profile") {
      const value = inline ??
        (i + 1 < argv.length ? argv[i + 1] : undefined);
      if (value !== undefined && !value.startsWith("-")) {
        (out as Record<string, unknown>)[name] = value;
        if (inline === undefined) i++;
      }
      continue;
    }
    if (inline === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      i++;
    }
  }
  return out;
}

export function commandPathOf(argv: string[]): string[] {
  return splitPathAndFlags(argv).path;
}

export function splitPathAndFlags(
  argv: string[],
): { path: string[]; flags: string[] } {
  const path: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") { flags.push(...argv.slice(i)); break; }
    if (!tok.startsWith("-")) { path.push(tok); continue; }
    flags.push(tok);
    const long = tok.startsWith("--");
    if (long) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      if (eq !== -1) continue;
      if (BOOLEANS.has(name)) continue;
      if (GLOBAL_FLAG_NAMES.has(name)) {
        if (i + 1 < argv.length) flags.push(argv[++i]);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.push(next);
        i++;
      }
    }
  }
  return { path, flags };
}
