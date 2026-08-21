import type { CmdCtx, Handler } from "../router.ts";
import type { ResourceKind } from "../clients/types.ts";
import { CliError } from "../errors.ts";
import { parseKind } from "../resolve/link.ts";
import { canPrompt, type PromptIO, select } from "../ui/prompt.ts";
import {
  detectKind,
  kindCommand,
  kindDisplay,
  type KindGuess,
} from "../build/detect-kind.ts";

export const DEPLOY_USAGE =
  "Usage: pbc cloud deploy [pb|frontend|backend] [<name>]";

const KINDS: ResourceKind[] = ["pocketbases", "frontends", "backends"];

/**
 * What to say when nothing in the directory points at a kind. Names all three
 * commands rather than one: the CLI genuinely does not know which is right,
 * and a suggestion it cannot back up would send half of these users the wrong
 * way. `pbc cloud init` is offered too, because recording the answer once is
 * better than passing it on every deploy.
 */
export function ambiguousMessage(cwd: string): string {
  return `Could not tell what is in ${cwd}. Deploy it explicitly:\n` +
    `  pbc cloud pb deploy         (a PocketBase instance)\n` +
    `  pbc cloud frontend deploy   (a static site)\n` +
    `  pbc cloud backend deploy    (a Deno/Bun/Node/Next.js server)\n` +
    `Or run \`pbc cloud init <kind>\` once to record it in pbc.json.`;
}

/**
 * `pbc cloud deploy` — the deploy command you can run without first deciding
 * which of the three you have.
 *
 * It does no deploying of its own. Every path ends in one of the three
 * existing handlers, with the context passed through untouched, so a flag that
 * works on `pbc cloud frontend deploy` works here and there is exactly one
 * implementation of each deploy to keep correct. What this adds is the
 * decision: the directory's binding, then its files, then — only when both say
 * nothing — a question.
 */
export function makeDeployCommands(
  deps: { cwd: () => string; io?: PromptIO },
  handlers: Record<ResourceKind, Handler>,
): Record<string, Handler> {
  const deploy: Handler = async (ctx: CmdCtx) => {
    const cwd = deps.cwd();
    // A leading kind word is an override, not a resource name: `pbc cloud
    // deploy backend` is the escape hatch for a directory detected wrongly,
    // and naming a resource "backend" is what --name is for.
    const explicit = ctx.args[0] ? parseKind(ctx.args[0]) : null;
    if (explicit) {
      return await handlers[explicit]({ ...ctx, args: ctx.args.slice(1) });
    }

    const guess = await detectKind(cwd);
    if (guess) {
      report(guess, ctx);
      return await handlers[guess.kind](ctx);
    }

    const opts = { noInput: ctx.flags.noInput || ctx.flags.json, io: deps.io };
    if (!canPrompt(opts)) throw new CliError(ambiguousMessage(cwd), 2);
    const picked = await select(
      "What is in this directory?",
      KINDS,
      (k) => kindDisplay(k),
      opts,
    );
    return await handlers[picked](ctx);
  };

  return { "cloud deploy": deploy };
}

/**
 * Names the guess and the command it resolved to, so the deploy that follows
 * is one a user recognises as theirs — and so the next one can be typed
 * directly. Silent under --json, where stdout carries the deploy's own object
 * and nothing else may touch it.
 */
function report(guess: KindGuess, ctx: CmdCtx): void {
  if (ctx.flags.json) return;
  console.log(
    `Detected a ${kindDisplay(guess.kind)} (${guess.reason}) — running ` +
      `\`pbc cloud ${kindCommand(guess.kind)} deploy\`.`,
  );
}
