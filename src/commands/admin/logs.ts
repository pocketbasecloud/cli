import type { CmdCtx, Handler } from "../../router.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { printResult } from "../../ui/output.ts";
import type { AdminRecord } from "../../clients/admin-types.ts";

export function makeInstanceLogsCommands(
  deps: AdminCmdDeps,
): Record<string, Handler> {
  const logs: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAdmin();
    const filter = ctx.raw.filter as string | undefined;
    const perPage = ctx.raw["per-page"] ? Number(ctx.raw["per-page"]) : 50;

    const render = (items: AdminRecord[]) => {
      if (ctx.flags.json) {
        for (const it of items) console.log(JSON.stringify(it));
      } else {
        printResult(items, [
          { header: "CREATED", get: (r) => String(r.created ?? "") },
          { header: "LEVEL", get: (r) => String(r.level ?? "") },
          { header: "MESSAGE", get: (r) => String(r.message ?? "") },
        ], false);
      }
    };

    if (ctx.raw.follow !== true) {
      const page = await client.listLogs({
        filter,
        page: ctx.raw.page ? Number(ctx.raw.page) : 1,
        perPage,
      });
      render(page.items);
      return 0;
    }

    // Follow mode: poll newest page, print entries with unseen ids.
    const seen = new Set<string>();
    while (true) {
      const page = await client.listLogs({ filter, page: 1, perPage });
      const fresh = page.items.filter((r) => !seen.has(r.id)).reverse();
      for (const r of fresh) seen.add(r.id);
      render(fresh);
      await new Promise((res) => setTimeout(res, 2000));
    }
  };

  return { "logs": logs };
}
