import {
  bool,
  str,
  type Command,
  defineCommand,
} from "../../command.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { emit } from "../../envelope.ts";
import { printResult } from "../../ui/output.ts";
import type { AdminRecord } from "../../clients/admin-types.ts";

export function makeInstanceLogsCommands(
  deps: AdminCmdDeps,
): Record<string, Command> {
  return {
    "admin requests": defineCommand({
      path: ["admin", "requests"],
      usage: "pbc admin requests [--filter <expr>] [--page <n>] [--per-page <n>] [-f]",
      summary: "Show instance request logs. -f follows new entries.",
      args: [],
      flags: {
        filter: str({ description: "PocketBase filter expression." }),
        page: str({ description: "Page number." }),
        perPage: str({ description: "Log entries per page." }),
        follow: bool({
          description: "Keep printing new log entries.",
          short: "f",
        }),
      },
      run: async (input, ctx) => {
        const { client } = await deps.requireAdmin(ctx);
        const filter = input.filter;
        const perPage = input.perPage ? Number(input.perPage) : 50;

        const render = (items: AdminRecord[]) => {
          if (ctx.flags.json) {
            for (const it of items) emit(true, it, "");
          } else {
            printResult(items, [
              { header: "CREATED", get: (r) => String(r.created ?? "") },
              { header: "LEVEL", get: (r) => String(r.level ?? "") },
              { header: "MESSAGE", get: (r) => String(r.message ?? "") },
            ], false);
          }
        };

        if (input.follow !== true) {
          const page = await client.listLogs({
            filter,
            page: input.page ? Number(input.page) : 1,
            perPage,
          });
          render(page.items);
          return 0;
        }

        const seen = new Set<string>();
        while (true) {
          const page = await client.listLogs({ filter, page: 1, perPage });
          const fresh = page.items.filter((r) => !seen.has(r.id)).reverse();
          for (const r of fresh) seen.add(r.id);
          render(fresh);
          await new Promise((res) => setTimeout(res, 2000));
        }
      },
    }),
  };
}
