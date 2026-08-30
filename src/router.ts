import { CliError, type ErrorCode } from "./errors.ts";
import type {
  ArgSpec,
  Command,
  CommandRegistry,
  Need,
} from "./command.ts";
import { canonicalKeys, kebabCase } from "./command.ts";
import { parseGlobalFlags } from "./globals.ts";
import type { ParseError } from "./parse.ts";
import { nearestCommand, parseCommand, resolveCommand } from "./parse.ts";
import { fillMissing, type PromptIO } from "./ui/prompt.ts";
import { type CommandTarget, targetsOf } from "./targets.ts";
import { emit, emitError } from "./envelope.ts";
export { nearestCommand };

const PARSE_ERROR_CODE: Record<ParseError["kind"], ErrorCode> = {
  "unknown-flag": "UNKNOWN_FLAG",
  "arity": "USAGE",
  "choices": "INVALID_VALUE",
  "required": "MISSING_ARG",
  "conflict": "USAGE",
  "passthrough": "USAGE",
};

export type ManifestFlag = {
  name: string;
  type: string;
  required: boolean;
  choices?: readonly string[];
  description?: string;
  renamedTo?: string;
  retired?: { since: string; note: string };
};

export type ManifestEntry = {
  usage: string;
  summary: string;
  details?: string;
  args: ArgSpec[];
  flags: ManifestFlag[];
  targets: readonly CommandTarget[];
  needs?: readonly Need[];
};

export function manifestEntry(command: Command): ManifestEntry {
  return {
    usage: command.usage,
    summary: command.summary,
    details: command.details,
    args: command.args,
    targets: targetsOf(command),
    ...(command.needs && command.needs.length > 0
      ? { needs: command.needs }
      : {}),
    flags: Object.entries(command.flags).map(([key, f]) => ({
      name: kebabCase(key),
      type: f.type,
      required: f.required === true,
      choices: f.choices,
      description: f.description,
      ...(f.renamedTo ? { renamedTo: kebabCase(f.renamedTo) } : {}),
      ...(f.retired ? { retired: f.retired } : {}),
    })),
  };
}

export async function dispatch(
  registry: CommandRegistry,
  argv: string[],
  io?: PromptIO,
): Promise<number> {
  const { path, command, rest, args } = resolveCommand(argv, registry);
  if (command) {
    const canonical = command.path.join(" ");
    const typed = path.join(" ");
    if (typed !== canonical) {
      console.error(`\`pbc ${typed}\` is deprecated — use \`pbc ${canonical}\`.`);
    }
  }
  if (!command) {
    const globals = parseGlobalFlags(rest);
    const suggestion = nearestCommand(path.join(" "), canonicalKeys(registry));
    const err = new CliError(
      `Unknown command: ${path.join(" ") || "(none)"}.` +
        (suggestion ? ` Did you mean \`pbc ${suggestion}\`?` : "") +
        " Try `pbc --help`.",
      { code: "USAGE", hint: suggestion ? `pbc ${suggestion}` : "pbc --help" },
    );
    console.error(`Error: ${err.message}`);
    emitError(globals.json, err);
    return err.exitCode;
  }
  const globals = parseGlobalFlags(rest);
  if (globals.help) {
    emit(
      globals.json,
      manifestEntry(command),
      () =>
        [command.usage, command.summary, command.details].filter(Boolean)
          .join("\n\n"),
    );
    return 0;
  }
  const outcome = parseCommand(command, rest, args, {
    interactive: globals.interactive,
  });
  if (!outcome.ok) {
    for (const e of outcome.errors) console.error(`Error: ${e.message}`);
    if (outcome.errors.some((e) => e.kind === "unknown-flag")) {
      console.error(`       pbc ${command.path.join(" ")} --help lists every flag.`);
    }
    const first = outcome.errors[0];
    const err = new CliError(first.message, {
      code: PARSE_ERROR_CODE[first.kind],
      hint: `pbc ${command.path.join(" ")} --help`,
    });
    emitError(globals.json, err);
    return err.exitCode;
  }
  try {
    if (globals.interactive) {
      if (globals.noInput) {
        throw new CliError(
          "--interactive cannot be combined with --no-input.",
          { code: "USAGE" },
        );
      }
      await fillMissing(command, outcome, { noInput: false, io });
    }
    return await command.run(outcome.input, {
      args: outcome.args,
      flags: globals,
    });
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`Error: ${e.message}`);
      emitError(globals.json, e);
      return e.exitCode;
    }
    const err = new CliError(
      e instanceof Error ? e.message : String(e),
      { code: "INTERNAL" },
    );
    console.error(`Unexpected error: ${err.message}`);
    emitError(globals.json, err);
    return err.exitCode;
  }
}
