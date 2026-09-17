import { defineCommand, type Command, type FlagSpec } from "../command.ts";
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

function sharedFlags(handlers: Record<ResourceKind, Command>): Record<string, FlagSpec> {
  const flags: Record<string, FlagSpec> = {};
  for (const kind of KINDS) {
    for (const [key, spec] of Object.entries(handlers[kind].flags)) {
      if (!(key in flags)) flags[key] = spec;
    }
  }
  return flags;
}

export function makeDeployCommands(
  deps: { cwd: () => string; io?: PromptIO },
  handlers: Record<ResourceKind, Command>,
): Record<string, Command> {
  return {
    deploy: defineCommand({
      path: ["deploy"],
      usage: "pbc deploy [pocketbase|frontend|backend] [<name>] [flags]",
      summary: "Deploy this directory, detecting what kind of resource it is.",
      details: `Works out whether the directory holds a PocketBase instance, a static
site, or a backend, then runs that kind's deploy — \`pbc pocketbase deploy\`,
\`pbc frontend deploy\`, or \`pbc backend deploy\`. Every flag those commands
accept works here and is passed straight through.

The first of these that applies decides:

  1. The "kind" recorded in pbc.json by a previous deploy — never re-guessed.
  2. pb_hooks/, pb_migrations/, or pb_public/ — a PocketBase instance.
  3. next.config.*: "output": "export" is a static site, anything else a backend.
  4. vite / svelte / vue config, or angular.json — a frontend.
  5. deno.json(c) — a backend.
  6. package.json dependencies, then its scripts: a server dep or a "start"
     script is a backend; a bundler dep or a lone "build" script a frontend.
  7. index.html in the directory or public/, dist/, build/, or out/ — a frontend.

The detected kind and the file that decided it are printed before the deploy
runs. A leading kind word overrides the detection outright:

  pbc deploy backend            # deploy as a backend, whatever is here
  pbc deploy frontend web       # …and redeploy the existing "web"

Env vars are pushed only from the dotenv file each environment names —
nothing by default. The first deploy of an environment asks which file (or
none) and records it in pbc.json. Pushing merges, keeping cloud-only keys;
--delete-missing makes the file the whole truth, and --skip-env pushes
nothing this run. An unchanged file is not re-uploaded without --force-env.

When nothing in the directory points either way you are asked on a terminal;
under --no-input or --json you get an error naming the three explicit
commands.`,
      args: [
        { name: "kind", required: false, description: "pocketbase, frontend, or backend; detected from the directory when omitted" },
        { name: "name", required: false, description: "The existing resource to redeploy, same as --name; create with --new" },
      ],
      flags: sharedFlags(handlers),
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
