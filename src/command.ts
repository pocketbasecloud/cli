import type { ResourceKind } from "./clients/types.ts";
import type { GlobalFlags } from "./globals.ts";
import type { CommandTarget } from "./targets.ts";

export type FlagSource = "pbc.json" | "env" | "flag";

type StringFlag = {
  type: "string";
  description: string;
  required?: boolean;
  choices?: readonly string[];
  short?: string;
  renamedTo?: string;
  conflicts?: readonly string[];
  source?: FlagSource;
  retired?: { since: string; note: string };
};

type PathFlag = {
  type: "path";
  description: string;
  required?: boolean;
  choices?: readonly string[];
  short?: string;
  renamedTo?: string;
  conflicts?: readonly string[];
  source?: FlagSource;
  retired?: { since: string; note: string };
};

type BooleanFlag = {
  type: "boolean";
  description: string;
  required?: boolean;
  choices?: readonly string[];
  short?: string;
  renamedTo?: string;
  conflicts?: readonly string[];
  source?: FlagSource;
  retired?: { since: string; note: string };
};

export type FlagSpec = StringFlag | PathFlag | BooleanFlag;

export type ArgSpec = { name: string; required: boolean; description?: string };

export type CmdCtx = { args: string[]; flags: GlobalFlags };

export type Need = `target:${ResourceKind}` | { explicit: true };

export type Command = {
  path: string[];
  usage: string;
  summary: string;
  details?: string;
  args: ArgSpec[];
  flags: Record<string, FlagSpec>;
  passthrough?: boolean;
  targets?: readonly CommandTarget[];
  needs?: readonly Need[];
  run: (input: Record<string, unknown>, ctx: CmdCtx) => Promise<number>;
};

export function targetKindOf(
  cmd: { needs?: readonly Need[] },
): ResourceKind | undefined {
  for (const n of cmd.needs ?? []) {
    if (typeof n === "string" && n.startsWith("target:")) {
      return n.slice("target:".length) as ResourceKind;
    }
  }
  return undefined;
}

export function requiresExplicitTarget(
  cmd: { needs?: readonly Need[] },
): boolean {
  return (cmd.needs ?? []).some((n) => typeof n === "object" && n.explicit);
}

export type CommandRegistry = Record<string, Command>;

export function canonicalKeys(registry: CommandRegistry): string[] {
  return Object.keys(registry).filter((k) => registry[k].path.join(" ") === k);
}

export type FlagValue<S extends FlagSpec> =
  S extends { type: "boolean" } ? boolean : string | undefined;

export type InferInput<F extends Record<string, FlagSpec>> = {
  [K in keyof F as F[K] extends { renamedTo: string } ? never
    : F[K] extends { retired: unknown } ? never
    : K]: FlagValue<F[K]>;
};

export function str(o: {
  description: string; required?: boolean; choices?: readonly string[];
  short?: string; source?: FlagSource; conflicts?: readonly string[];
}): StringFlag {
  return { type: "string", required: false, ...o };
}

export function path(o: {
  description: string; required?: boolean; short?: string;
  conflicts?: readonly string[];
}): PathFlag {
  return { type: "path", required: false, ...o };
}

export function bool(o: {
  description: string; required?: boolean; short?: string;
  conflicts?: readonly string[];
}): BooleanFlag {
  return { type: "boolean", required: false, ...o };
}

export function renamed<T extends string>(target: T, o: {
  description: string; required?: boolean; short?: string;
}): {
  type: "string"; description: string; required: boolean;
  short?: string; renamedTo: T;
} {
  return {
    type: "string",
    description: o.description,
    required: o.required ?? false,
    ...(o.short !== undefined ? { short: o.short } : {}),
    renamedTo: target,
  };
}

export function retired<T extends "string" | "boolean">(o: {
  description: string; since: string; note: string; type?: T;
}): {
  type: T; description: string; required: false;
  retired: { since: string; note: string };
} {
  return {
    type: (o.type ?? "string") as T,
    description: o.description,
    required: false,
    retired: { since: o.since, note: o.note },
  };
}

export function defineCommand<F extends Record<string, FlagSpec>>(def: {
  path: string[];
  usage: string;
  summary: string;
  details?: string;
  args?: ArgSpec[];
  flags: F;
  passthrough?: boolean;
  targets?: readonly CommandTarget[];
  needs?: readonly Need[];
  run: (input: InferInput<F>, ctx: CmdCtx) => Promise<number>;
}): Command {
  return { args: [], ...def, run: def.run as unknown as Command["run"] };
}

export function camelCase(name: string): string {
  return name.replace(/^-/, "").replace(/-([a-z0-9])/g, (_, c: string) =>
    c.toUpperCase());
}

export function kebabCase(name: string): string {
  return name.replace(/([A-Z])/g, "-$1").toLowerCase();
}
