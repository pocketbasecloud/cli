import { parseArgs } from "@std/cli/parse-args";
import { CliError } from "./errors.ts";
import type { CommandSpec } from "./usage.ts";
import { fillMissingFromSpec, type PromptIO } from "./ui/prompt.ts";

export type GlobalFlags = {
  json: boolean;
  yes: boolean;
  noInput: boolean;
  interactive: boolean;
  help?: boolean;
  project?: string;
  profile?: string;
};
export type CmdCtx = {
  args: string[];
  flags: GlobalFlags;
  raw: Record<string, unknown>;
};
export type Handler = (ctx: CmdCtx) => Promise<number>;

export function parseGlobal(argv: string[]): { path: string[]; ctx: CmdCtx } {
  const parsed = parseArgs(argv, {
    boolean: [
      "json",
      "yes",
      "no-input",
      "interactive",
      "follow",
      "none",
      "remove",
      "delete-missing",
      "help",
      "all",
      "pre",
      "force",
    ],
    string: [
      "project",
      "profile",
      "dir",
      "os",
      "arch",
      "org",
      "name",
      "id",
      "target",
      "location",
      "server",
      "runtime",
      "start",
      "zip",
      "out",
      "url",
      "email",
      "password",
      "filter",
      "sort",
      "page",
      "per-page",
      "data",
      "set",
      "list-rule",
      "view-rule",
      "create-rule",
      "update-rule",
      "delete-rule",
    ],
    alias: { y: "yes", f: "follow", h: "help", i: "interactive" },
    "--": false,
  });
  const path = parsed._.map(String);
  const flags: GlobalFlags = {
    json: parsed.json === true,
    yes: parsed.yes === true,
    noInput: parsed["no-input"] === true,
    interactive: parsed.interactive === true,
    help: parsed.help === true,
    project: parsed.project as string | undefined,
    profile: parsed.profile as string | undefined,
  };
  return {
    path,
    ctx: { args: path, flags, raw: parsed as Record<string, unknown> },
  };
}

export async function dispatch(
  registry: Record<string, Handler>,
  argv: string[],
  commands?: Record<string, CommandSpec>,
  io?: PromptIO,
): Promise<number> {
  const { path, ctx } = parseGlobal(argv);
  for (let n = path.length; n >= 1; n--) {
    const key = path.slice(0, n).join(" ");
    const handler = registry[key];
    if (handler) {
      ctx.args = path.slice(n);
      const spec = commands?.[key];
      if (ctx.flags.help) {
        if (ctx.flags.json) {
          const fallback: CommandSpec = {
            usage: `Usage: pb ${key}`,
            summary: "",
            args: [],
            flags: [],
          };
          console.log(
            JSON.stringify({ command: key, ...(spec ?? fallback) }, null, 2),
          );
        } else if (spec) {
          console.log(
            [spec.usage, spec.summary, spec.details].filter(Boolean).join(
              "\n\n",
            ),
          );
        } else {
          console.log(`Usage: pb ${key}`);
        }
        return 0;
      }
      try {
        if (ctx.flags.interactive) {
          if (ctx.flags.noInput) {
            throw new CliError(
              "--interactive cannot be combined with --no-input.",
              2,
            );
          }
          if (spec) {
            await fillMissingFromSpec(spec, ctx, { noInput: false, io });
          }
        }
        return await handler(ctx);
      } catch (e) {
        if (e instanceof CliError) {
          console.error(
            ctx.flags.json
              ? JSON.stringify({ error: e.message })
              : `Error: ${e.message}`,
          );
          return e.exitCode;
        }
        console.error(
          `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
        );
        return 1;
      }
    }
  }
  console.error(
    `Unknown command: ${path.join(" ") || "(none)"}. Try \`pb --help\`.`,
  );
  return 1;
}
