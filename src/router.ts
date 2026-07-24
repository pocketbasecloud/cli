import { parseArgs } from "@std/cli/parse-args";
import { CliError } from "./errors.ts";
import type { CommandSpec } from "./usage.ts";

export type GlobalFlags = {
  json: boolean;
  yes: boolean;
  noInput: boolean;
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
    alias: { y: "yes", f: "follow", h: "help" },
    "--": false,
  });
  const path = parsed._.map(String);
  const flags: GlobalFlags = {
    json: parsed.json === true,
    yes: parsed.yes === true,
    noInput: parsed["no-input"] === true,
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
): Promise<number> {
  const { path, ctx } = parseGlobal(argv);
  for (let n = path.length; n >= 1; n--) {
    const key = path.slice(0, n).join(" ");
    const handler = registry[key];
    if (handler) {
      ctx.args = path.slice(n);
      if (ctx.flags.help) {
        const spec = commands?.[key];
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
