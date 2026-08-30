import type { Command, CommandRegistry, FlagSpec } from "./command.ts";
import { kebabCase } from "./command.ts";
import { GLOBAL_FLAGS } from "./globals.ts";

export type ParseError = {
  kind: "unknown-flag" | "arity" | "choices" | "required" | "conflict" | "passthrough";
  message: string;
};

export type ParseOutcome =
  | {
      ok: true;
      command: Command;
      input: Record<string, unknown>;
      passthrough: string[];
      args: string[];
    }
  | { ok: false; errors: ParseError[] };

export type ParseOpts = {
  allowUnknownFlags?: boolean;
  env?: (k: string) => string | undefined;
  interactive?: boolean;
};

export function resolveCommand(
  argv: string[],
  registry: CommandRegistry,
): { path: string[]; command?: Command; rest: string[]; args: string[] } {
  const leading: string[] = [];
  let restStart = argv.length;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("-")) { restStart = i; break; }
    leading.push(argv[i]);
  }
  const rest = argv.slice(restStart);
  for (let n = leading.length; n >= 1; n--) {
    const key = leading.slice(0, n).join(" ");
    const cmd = registry[key];
    if (cmd) {
      return {
        path: leading.slice(0, n), command: cmd, rest, args: leading.slice(n),
      };
    }
  }
  return { path: leading, command: undefined, rest, args: [] };
}

function canBeValue(tok: string, shorts: Map<string, string>): boolean {
  if (!tok.startsWith("-")) return true;
  if (tok.startsWith("--")) return false;
  const eq = tok.indexOf("=");
  return !shorts.has(tok.slice(1, eq === -1 ? tok.length : eq));
}

export function parseCommand(
  command: Command,
  rest: string[],
  initialArgs: string[],
  opts: ParseOpts = {},
): ParseOutcome {
  const env = opts.env ?? ((k: string) => Deno.env.get(k));
  const allowUnknown = opts.allowUnknownFlags ??
    (env("PBC_ALLOW_UNKNOWN_FLAGS") !== undefined &&
      env("PBC_ALLOW_UNKNOWN_FLAGS") !== "");

  let before = rest;
  let passthrough: string[] = [];
  const dd = rest.indexOf("--");
  if (dd !== -1) {
    before = rest.slice(0, dd);
    passthrough = rest.slice(dd + 1);
    if (passthrough.length > 0 && !command.passthrough) {
      return {
        ok: false,
        errors: [{
          kind: "passthrough",
          message:
            `\`--\` passthrough is not enabled for \`pbc ${command.path.join(" ")}\`.`,
        }],
      };
    }
  }

  const specByName = new Map<string, FlagSpec>();
  for (const [key, f] of Object.entries(command.flags)) {
    specByName.set(kebabCase(key), f);
  }
  const retiredNames = new Set<string>();
  for (const [key, f] of Object.entries(command.flags)) {
    if (f.retired) retiredNames.add(kebabCase(key));
  }
  for (const f of GLOBAL_FLAGS) specByName.set(f.name, f);
  const shortByName = new Map<string, string>();
  for (const [key, f] of Object.entries(command.flags)) {
    if (f.short) shortByName.set(f.short, kebabCase(key));
  }
  for (const f of GLOBAL_FLAGS) {
    if (f.short) shortByName.set(f.short, f.name);
  }

  const args = [...initialArgs];
  const seen: Record<string, unknown> = {};
  const unknownNames: { name: string; typed: string }[] = [];
  const unknownValues: Record<string, unknown> = {};
  const errors: ParseError[] = [];

  let i = 0;
  while (i < before.length) {
    const tok = before[i];
    if (!tok.startsWith("-")) { args.push(tok); i++; continue; }
    const eq = tok.indexOf("=");
    const long = tok.startsWith("--");
    const rawName = long
      ? tok.slice(2, eq === -1 ? tok.length : eq)
      : tok.slice(1, eq === -1 ? tok.length : eq);
    const inline = eq === -1 ? undefined : tok.slice(eq + 1);
    const name = long ? rawName : (shortByName.get(rawName) ?? rawName);
    const typed = long ? `--${rawName}` : `-${rawName}`;
    const spec = specByName.get(name);

    if (!spec) {
      if (allowUnknown) {
        if (inline !== undefined) unknownValues[name] = inline;
        else if (i + 1 < before.length && !before[i + 1].startsWith("-")) {
          unknownValues[name] = before[i + 1];
          i++;
        } else unknownValues[name] = true;
      } else {
        unknownNames.push({ name, typed });
      }
      i++;
      continue;
    }

    if (spec.type === "boolean") {
      seen[name] = inline === undefined ? true : inline === "true";
      i++;
      continue;
    }

    if (inline !== undefined) {
      seen[name] = inline;
      i++;
      continue;
    }
    const value = before[i + 1];
    if (value === undefined || !canBeValue(value, shortByName)) {
      errors.push({ kind: "arity", message: `flag ${typed} requires a value.` });
      i++;
      continue;
    }
    seen[name] = value;
    i += 2;
  }

  if (unknownNames.length > 0) {
    for (const { name, typed } of unknownNames) {
      const suggestion = nearestFlag(name, specByName.keys());
      errors.push({
        kind: "unknown-flag",
        message: suggestion
          ? `unknown flag ${typed}. Did you mean --${suggestion}?`
          : `unknown flag ${typed}.`,
      });
    }
    return { ok: false, errors };
  }

  const argSpecs = command.args;
  const requiredArgs = argSpecs.filter((a) => a.required).length;
  if (args.length < requiredArgs && !opts.interactive) {
    for (const a of argSpecs.filter((x) => x.required)) {
      errors.push({
        kind: "required", message: `missing required argument <${a.name}>.`,
      });
    }
  } else if (argSpecs.length > 0 && args.length > argSpecs.length) {
    errors.push({
      kind: "arity",
      message: `unexpected argument: ${args.slice(argSpecs.length).join(" ")}.`,
    });
  }

  for (const [key, f] of Object.entries(command.flags)) {
    const name = kebabCase(key);
    const val = seen[name];
    if (f.choices && typeof val === "string" && !f.choices.includes(val)) {
      errors.push({
        kind: "choices",
        message: `--${name} must be one of: ${f.choices.join(", ")}.`,
      });
    }
  }

  for (const [key, f] of Object.entries(command.flags)) {
    const name = kebabCase(key);
    for (const other of f.conflicts ?? []) {
      const otherName = kebabCase(other);
      if (seen[name] !== undefined && seen[otherName] !== undefined) {
        errors.push({
          kind: "conflict",
          message: `--${name} and --${otherName} cannot be combined.`,
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const folded: Record<string, unknown> = { ...seen };
  for (const [key, f] of Object.entries(command.flags)) {
    const name = kebabCase(key);
    if (f.renamedTo) {
      const target = kebabCase(f.renamedTo);
      if (seen[name] !== undefined && folded[target] === undefined) {
        folded[target] = seen[name];
      }
      delete folded[name];
    }
  }
  for (const name of retiredNames) delete folded[name];

  const camelByKebab = new Map<string, string>();
  for (const key of Object.keys(command.flags)) {
    camelByKebab.set(kebabCase(key), key);
  }
  const input: Record<string, unknown> = {};
  for (const [key, f] of Object.entries(command.flags)) {
    if (f.type !== "boolean" || f.renamedTo || f.retired) continue;
    if (folded[kebabCase(key)] === undefined) input[key] = false;
  }
  for (const [name, value] of Object.entries(folded)) {
    input[camelByKebab.get(name) ?? name] = value;
  }
  if (allowUnknown) Object.assign(input, unknownValues);

  return { ok: true, command, input, passthrough, args };
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

export function nearestCommand(attempted: string, keys: string[]): string | null {
  if (!attempted) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const key of keys) {
    const d = editDistance(attempted, key);
    if (d < bestDist) { bestDist = d; best = key; }
  }
  const threshold = Math.max(2, Math.floor(attempted.length / 3));
  return best !== null && bestDist <= threshold ? best : null;
}

export function nearestFlag(
  attempted: string,
  candidates: Iterable<string>,
): string | null {
  return nearestCommand(attempted, [...candidates]);
}
