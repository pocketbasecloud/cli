import {
  str,
  type Command,
  defineCommand,
} from "../../command.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";
import { emit } from "../../envelope.ts";
import { renderTable } from "../../ui/output.ts";
import { confirm } from "../../ui/prompt.ts";

export function makeRecordsCommands(
  deps: AdminCmdDeps,
): Record<string, Command> {
  return {
    "admin records ls": defineCommand({
      path: ["admin", "records", "ls"],
      usage:
        "pbc admin records ls <collection> [--filter <expr>] [--sort <expr>] [--page <n>] [--per-page <n>]",
      summary: "List records in a collection.",
      args: [{ name: "collection", required: true }],
      flags: {
        filter: str({ description: "PocketBase filter expression." }),
        sort: str({ description: "Sort expression, e.g. -created." }),
        page: str({ description: "Page number." }),
        perPage: str({ description: "Records per page." }),
      },
      run: async (input, ctx) => {
        const collection = ctx.args[0];
        if (!collection) {
          throw new CliError(
            "Usage: pbc admin records ls <collection> [--filter] [--sort]",
            { code: "USAGE" });
        }
        const { client } = await deps.requireAdmin(ctx);
        const page = await client.listRecords(collection, {
          filter: input.filter,
          sort: input.sort,
          page: input.page ? Number(input.page) : undefined,
          perPage: input.perPage ? Number(input.perPage) : undefined,
        });
        emit(ctx.flags.json, page, () =>
          [
            renderTable(page.items, [
              { header: "ID", get: (r) => r.id },
              {
                header: "FIELDS",
                get: (r) => Object.keys(r).filter((k) => k !== "id").join(","),
              },
            ]),
            `\nPage ${page.page} — ${page.totalItems} total.`,
          ].join("\n"));
        return 0;
      },
    }),

    "admin records get": defineCommand({
      path: ["admin", "records", "get"],
      usage: "pbc admin records get <collection> <id>",
      summary: "Show a record.",
      args: [
        { name: "collection", required: true },
        { name: "id", required: true },
      ],
      flags: {},
      run: async (_input, ctx) => {
        const [collection, id] = ctx.args;
        if (!collection || !id) {
          throw new CliError(
            "Usage: pbc admin records get <collection> <id>",
            { code: "USAGE" },
          );
        }
        const { client } = await deps.requireAdmin(ctx);
        const record = await client.getRecord(collection, id);
        emit(ctx.flags.json, record, () => JSON.stringify(record, null, 2));
        return 0;
      },
    }),

    "admin records create": defineCommand({
      path: ["admin", "records", "create"],
      usage: "pbc admin records create <collection> '<json>'",
      summary: "Create a record.",
      args: [
        { name: "collection", required: true },
        { name: "json", required: true },
      ],
      flags: {
        data: str({
          description: "The JSON payload, alternative to the positional.",
        }),
      },
      run: async (input, ctx) => {
        const collection = ctx.args[0];
        const json = ctx.args[1] ?? input.data;
        if (!collection || !json) {
          throw new CliError(
            "Usage: pbc admin records create <collection> '<json>'",
            { code: "USAGE" },
          );
        }
        const { client } = await deps.requireAdmin(ctx);
        const data = JSON.parse(json) as Record<string, unknown>;
        const r = await client.createRecord(collection, data);
        emit(ctx.flags.json, r, `Created record ${r.id}.`);
        return 0;
      },
    }),

    "admin records update": defineCommand({
      path: ["admin", "records", "update"],
      usage: "pbc admin records update <collection> <id> '<json>'",
      summary: "Update a record.",
      args: [
        { name: "collection", required: true },
        { name: "id", required: true },
        { name: "json", required: true },
      ],
      flags: {
        data: str({
          description: "The JSON payload, alternative to the positional.",
        }),
      },
      run: async (input, ctx) => {
        const [collection, id] = ctx.args;
        const json = ctx.args[2] ?? input.data;
        if (!collection || !id || !json) {
          throw new CliError(
            "Usage: pbc admin records update <collection> <id> '<json>'",
            { code: "USAGE" });
        }
        const { client } = await deps.requireAdmin(ctx);
        const data = JSON.parse(json) as Record<string, unknown>;
        const r = await client.updateRecord(collection, id, data);
        emit(ctx.flags.json, r, `Updated record ${r.id}.`);
        return 0;
      },
    }),

    "admin records rm": defineCommand({
      path: ["admin", "records", "rm"],
      usage: "pbc admin records rm <collection> <id> [--yes]",
      summary: "Delete a record.",
      args: [
        { name: "collection", required: true },
        { name: "id", required: true },
      ],
      flags: {},
      run: async (_input, ctx) => {
        const [collection, id] = ctx.args;
        if (!collection || !id) {
          throw new CliError(
            "Usage: pbc admin records rm <collection> <id>",
            { code: "USAGE" },
          );
        }
        const { client } = await deps.requireAdmin(ctx);
        if (
          !await confirm(`Delete record ${id} from ${collection}?`, {
            noInput: ctx.flags.noInput,
            yes: ctx.flags.yes,
          })
        ) {
          console.error("Aborted.");
          return 0;
        }
        await client.deleteRecord(collection, id);
        emit(ctx.flags.json, { ok: true }, `Deleted record ${id}.`);
        return 0;
      },
    }),
  };
}
