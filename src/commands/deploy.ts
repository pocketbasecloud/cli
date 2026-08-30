import { defineCommand, type Command } from "../command.ts";
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

const KINDS: ResourceKind[] = ["pocketbases", "frontends", "backends"];

export function ambiguousMessage(cwd: string): string {
  return `Could not tell what is in ${cwd}. Deploy it explicitly:\n` +
    `  pbc pocketbase deploy   (a PocketBase instance)\n` +
    `  pbc frontend deploy     (a static site)\n` +
    `  pbc backend deploy      (a Deno/Bun/Node/Next.js server)\n` +
    `Or run \`pbc init <kind>\` once to record it in pbc.json.`;
}

export function makeDeployCommands(
  deps: { cwd: () => string; io?: PromptIO },
  handlers: Record<ResourceKind, Command>,
): Record<string, Command> {
  return {
    deploy: defineCommand({
      path: ["deploy"],
      usage: "pbc deploy [pocketbase|frontend|backend] [<name>] [<deploy flags>]",
      summary: "Deploy this directory, detecting what kind of resource it is.",
      details: `Works out whether the directory holds a PocketBase instance, a static
site, or a backend, then runs that kind's deploy — \`pbc pocketbase deploy\`,
\`pbc frontend deploy\`, or \`pbc backend deploy\`. Every flag those
commands accept works here and is passed straight through, and the deploy
itself is identical: this command only makes the choice.

The answer comes from the first of these that applies:

  1. The "kind" recorded in pbc.json, which a previous deploy wrote. A
     deployed directory is never re-guessed.
  2. A pb_hooks, pb_migrations, or pb_public directory — a PocketBase project.
  3. next.config.*, read for its "output": "export" builds a static site,
     anything else runs a Next.js server.
  4. vite / svelte / vue config, or angular.json — a frontend.
  5. deno.json(c) — a backend.
  6. package.json: a server dependency (express, fastify, hono, nest, …) is a
     backend and a bundler dependency (vite, react-scripts, parcel, …) is a
     frontend; failing both, a "start" script is a backend and a "build"
     script alone is a frontend.
  7. index.html in the directory or in public/, dist/, build/, or out/ —
     a frontend.

The detected kind and the file that decided it are printed before the deploy
runs, so a wrong guess is visible rather than surprising.

A leading kind word overrides the detection outright:

  pbc deploy backend            # deploy as a backend, whatever is here
  pbc deploy frontend web       # …and redeploy the existing "web"

When nothing in the directory points either way, you are asked on a terminal
and get an error naming the three explicit commands under --no-input or
--json.`,
      args: [
        { name: "kind", required: false, description: "pocketbase, frontend, or backend; detected from the directory when omitted" },
        { name: "name", required: false, description: "The existing resource to redeploy, same as --name; create with --new" },
      ],
      flags: {},
      run: async (_input, ctx) => {
        const cwd = deps.cwd();
        const explicit = ctx.args[0] ? parseKind(ctx.args[0]) : null;
        if (explicit) {
          return await handlers[explicit].run(_input, {
            ...ctx,
            args: ctx.args.slice(1),
          });
        }

        const guess = await detectKind(cwd);
        if (guess) {
          report(guess, ctx);
          return await handlers[guess.kind].run(_input, ctx);
        }

        const opts = { noInput: ctx.flags.noInput || ctx.flags.json, io: deps.io };
        if (!canPrompt(opts)) throw new CliError(
          ambiguousMessage(cwd),
          { code: "USAGE" },
        );
        const picked = await select(
          "What is in this directory?",
          KINDS,
          (k) => kindDisplay(k),
          opts,
        );
        return await handlers[picked].run(_input, ctx);
      },
    }),
  };
}

function report(guess: KindGuess, ctx: { flags: { json: boolean } }): void {
  if (ctx.flags.json) return;
  console.log(
    `Detected a ${kindDisplay(guess.kind)} (${guess.reason}) — running ` +
      `\`pbc ${kindCommand(guess.kind)} deploy\`.`,
  );
}
