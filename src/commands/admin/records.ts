import type { CmdCtx, Handler } from "../../router.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";
import { printResult } from "../../ui/output.ts";
import { confirm } from "../../ui/prompt.ts";

export function makeRecordsCommands(
  deps: AdminCmdDeps,
): Record<string, Handler> {
  const ls: Handler = async (ctx: CmdCtx) => {
    const collection = ctx.args[0];
    if (!collection) {
      throw new CliError(
        "Usage: pbc records ls <collection> [--filter] [--sort]",
        2,
      );
    }
    const { client } = await deps.requireAdmin();
    const page = await client.listRecords(collection, {
      filter: ctx.raw.filter as string | undefined,
      sort: ctx.raw.sort as string | undefined,
      page: ctx.raw.page ? Number(ctx.raw.page) : undefined,
      perPage: ctx.raw["per-page"] ? Number(ctx.raw["per-page"]) : undefined,
    });
    if (ctx.flags.json) {
      console.log(JSON.stringify(page, null, 2));
    } else {
      printResult(page.items, [
        { header: "ID", get: (r) => r.id },
        {
          header: "FIELDS",
          get: (r) => Object.keys(r).filter((k) => k !== "id").join(","),
        },
      ], false);
      console.log(`\nPage ${page.page} — ${page.totalItems} total.`);
    }
    return 0;
  };

  const get: Handler = async (ctx: CmdCtx) => {
    const [collection, id] = ctx.args;
    if (!collection || !id) {
      throw new CliError("Usage: pbc records get <collection> <id>", 2);
    }
    const { client } = await deps.requireAdmin();
    console.log(
      JSON.stringify(await client.getRecord(collection, id), null, 2),
    );
    return 0;
  };

  const create: Handler = async (ctx: CmdCtx) => {
    const collection = ctx.args[0];
    const json = ctx.args[1] ?? (ctx.raw.data as string | undefined);
    if (!collection || !json) {
      throw new CliError("Usage: pbc records create <collection> '<json>'", 2);
    }
    const { client } = await deps.requireAdmin();
    const data = JSON.parse(json) as Record<string, unknown>;
    const r = await client.createRecord(collection, data);
    console.log(ctx.flags.json ? JSON.stringify(r) : `Created record ${r.id}.`);
    return 0;
  };

  const update: Handler = async (ctx: CmdCtx) => {
    const [collection, id] = ctx.args;
    const json = ctx.args[2] ?? (ctx.raw.data as string | undefined);
    if (!collection || !id || !json) {
      throw new CliError(
        "Usage: pbc records update <collection> <id> '<json>'",
        2,
      );
    }
    const { client } = await deps.requireAdmin();
    const data = JSON.parse(json) as Record<string, unknown>;
    const r = await client.updateRecord(collection, id, data);
    console.log(ctx.flags.json ? JSON.stringify(r) : `Updated record ${r.id}.`);
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const [collection, id] = ctx.args;
    if (!collection || !id) {
      throw new CliError("Usage: pbc records rm <collection> <id>", 2);
    }
    const { client } = await deps.requireAdmin();
    if (
      !await confirm(`Delete record ${id} from ${collection}?`, {
        noInput: ctx.flags.noInput,
        yes: ctx.flags.yes,
      })
    ) {
      console.log("Aborted.");
      return 0;
    }
    await client.deleteRecord(collection, id);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleted record ${id}.`,
    );
    return 0;
  };

  return {
    "records ls": ls,
    "records get": get,
    "records create": create,
    "records update": update,
    "records rm": rm,
  };
}
