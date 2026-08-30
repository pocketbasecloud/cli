import { CliError } from "../errors.ts";
import type { Command } from "../command.ts";
import { kebabCase } from "../command.ts";
import type { ParseOutcome } from "../parse.ts";
import { pauseProgress } from "./progress.ts";

export type PromptIO = {
  read: () => Promise<string | null>;
  write: (s: string) => void;
  isTTY: boolean;
};
export type PromptOpts = { noInput: boolean; io?: PromptIO };

function stdinIO(): PromptIO {
  const dec = new TextDecoder();
  return {
    read: async () => {
      const buf = new Uint8Array(1024);
      const n = await Deno.stdin.read(buf);
      return n === null
        ? null
        : dec.decode(buf.subarray(0, n)).replace(/\r?\n$/, "");
    },
    write: (s) => Deno.stderr.writeSync(new TextEncoder().encode(s)),
    isTTY: Deno.stdin.isTerminal(),
  };
}

function resolveIO(opts: PromptOpts): PromptIO {
  const io = opts.io ?? stdinIO();
  if (opts.noInput || !io.isTTY) {
    throw new CliError(
      "Input required but running non-interactively (--no-input).",
      { code: "USAGE" });
  }
  return io;
}

export function canPrompt(opts: PromptOpts): boolean {
  if (opts.noInput) return false;
  return (opts.io ?? stdinIO()).isTTY;
}

function ask<T>(fn: () => Promise<T>): Promise<T> {
  return pauseProgress(fn);
}

export async function prompt(
  question: string,
  opts: PromptOpts,
): Promise<string> {
  const io = resolveIO(opts);
  return await ask(async () => {
    io.write(`${question} `);
    const answer = await io.read();
    return (answer ?? "").trim();
  });
}

export async function confirm(
  question: string,
  opts: PromptOpts & { yes: boolean },
): Promise<boolean> {
  if (opts.yes) return true;
  if (!canPrompt(opts)) {
    throw new CliError(
      "This action needs confirmation. Pass --yes to proceed.",
      { code: "USAGE" });
  }
  const io = resolveIO(opts);
  return await ask(async () => {
    io.write(`${question} [y/N] `);
    const answer = (await io.read() ?? "").trim().toLowerCase();
    return answer === "y" || answer === "yes";
  });
}

async function promptRequired(
  question: string,
  opts: PromptOpts,
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const answer = await prompt(question, opts);
    if (answer.length > 0) return answer;
  }
  throw new CliError("A required value was not provided.", { code: "USAGE" });
}

export async function fillMissing(
  command: Command,
  outcome: Extract<ParseOutcome, { ok: true }>,
  opts: PromptOpts,
): Promise<void> {
  for (let i = 0; i < command.args.length; i++) {
    const a = command.args[i];
    if (!a.required) continue;
    if (outcome.args[i] !== undefined && String(outcome.args[i]).length > 0) continue;
    outcome.args[i] = await promptRequired(`${a.name}:`, opts);
  }
  for (const [key, f] of Object.entries(command.flags)) {
    if (!f.required) continue;
    const name = kebabCase(key);
    const cur = outcome.input[key];
    if (cur !== undefined && cur !== "" && cur !== null) continue;
    const q = f.description ? `${name} (${f.description}):` : `${name}:`;
    if (f.choices && f.choices.length > 0) {
      outcome.input[key] = await select(q, f.choices, (c) => c, opts);
    } else if (f.type === "boolean") {
      outcome.input[key] = await confirm(q, { ...opts, yes: false });
    } else {
      outcome.input[key] = await promptRequired(q, opts);
    }
  }
}

export async function select<T>(
  question: string,
  items: readonly T[],
  label: (t: T, index: number) => string,
  opts: PromptOpts,
): Promise<T> {
  const io = resolveIO(opts);
  const raw = await ask(async () => {
    io.write(`${question}\n`);
    items.forEach((it, i) => io.write(`  ${i + 1}) ${label(it, i)}\n`));
    io.write("> ");
    return (await io.read() ?? "").trim();
  });
  const idx = Number(raw) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
    throw new CliError(`Invalid selection: ${raw}`, { code: "USAGE" });
  }
  return items[idx];
}
