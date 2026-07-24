import { CliError } from "../errors.ts";
import type { CommandSpec } from "../usage.ts";

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
    write: (s) => Deno.stdout.writeSync(new TextEncoder().encode(s)),
    isTTY: Deno.stdin.isTerminal(),
  };
}

function resolveIO(opts: PromptOpts): PromptIO {
  const io = opts.io ?? stdinIO();
  if (opts.noInput || !io.isTTY) {
    throw new CliError(
      "Input required but running non-interactively (--no-input).",
      2,
    );
  }
  return io;
}

export async function prompt(
  question: string,
  opts: PromptOpts,
): Promise<string> {
  const io = resolveIO(opts);
  io.write(`${question} `);
  const answer = await io.read();
  return (answer ?? "").trim();
}

export async function confirm(
  question: string,
  opts: PromptOpts & { yes: boolean },
): Promise<boolean> {
  if (opts.yes) return true;
  const io = resolveIO(opts);
  io.write(`${question} [y/N] `);
  const answer = (await io.read() ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** Prompt repeatedly until a non-empty answer is given (a required value). */
async function promptRequired(
  question: string,
  opts: PromptOpts,
): Promise<string> {
  // Bounded so a closed stdin (EOF returns "") can never spin forever.
  for (let attempt = 0; attempt < 10; attempt++) {
    const answer = await prompt(question, opts);
    if (answer.length > 0) return answer;
  }
  throw new CliError("A required value was not provided.", 2);
}

/**
 * Fill required args/flags that were not supplied on the command line by
 * prompting for them, mutating `ctx` in place. Driven entirely by the
 * command's `CommandSpec`: only fields marked `required: true` are prompted,
 * and values already present are left untouched.
 */
export async function fillMissingFromSpec(
  spec: CommandSpec,
  ctx: { args: string[]; raw: Record<string, unknown> },
  opts: PromptOpts,
): Promise<void> {
  for (let i = 0; i < spec.args.length; i++) {
    const a = spec.args[i];
    if (!a.required) continue;
    const cur = ctx.args[i];
    if (cur !== undefined && String(cur).length > 0) continue;
    ctx.args[i] = await promptRequired(`${a.name}:`, opts);
  }
  for (const f of spec.flags) {
    if (!f.required) continue;
    const cur = ctx.raw[f.name];
    if (cur !== undefined && cur !== "" && cur !== null) continue;
    const q = f.description ? `${f.name} (${f.description}):` : `${f.name}:`;
    if (f.choices && f.choices.length > 0) {
      ctx.raw[f.name] = await select(q, f.choices, (c) => c, opts);
    } else if (f.type === "boolean") {
      ctx.raw[f.name] = await confirm(q, { ...opts, yes: false });
    } else {
      ctx.raw[f.name] = await promptRequired(q, opts);
    }
  }
}

export async function select<T>(
  question: string,
  items: T[],
  label: (t: T) => string,
  opts: PromptOpts,
): Promise<T> {
  const io = resolveIO(opts);
  io.write(`${question}\n`);
  items.forEach((it, i) => io.write(`  ${i + 1}) ${label(it)}\n`));
  io.write("> ");
  const raw = (await io.read() ?? "").trim();
  const idx = Number(raw) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
    throw new CliError(`Invalid selection: ${raw}`, 2);
  }
  return items[idx];
}
