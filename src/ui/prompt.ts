import { CliError } from "../errors.ts";

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
