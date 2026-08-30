import {
  bool,
  type Command,
  defineCommand,
  str,
} from "../../command.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";
import { emit } from "../../envelope.ts";
import { printResult } from "../../ui/output.ts";
import { confirm } from "../../ui/prompt.ts";

function parseDefinition(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new CliError(
      `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      { code: "USAGE" });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      "A collection definition must be a JSON object.",
      { code: "USAGE" },
    );
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.length === 0) {
    throw new CliError('The definition needs a "name".', { code: "USAGE" });
  }
  body.type ??= "base";
  return body;
}

export function makeCollectionsCommands(
  deps: AdminCmdDeps,
): Record<string, Command> {
  return {
    "admin collections ls": defineCommand({
      path: ["admin", "collections", "ls"],
      usage: "pbc admin collections ls",
      summary: "List collections.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client } = await deps.requireAdmin();
        printResult(await client.listCollections(), [
          { header: "ID", get: (c) => c.id },
          { header: "NAME", get: (c) => c.name },
          { header: "TYPE", get: (c) => c.type },
          { header: "SYSTEM", get: (c) => (c.system ? "yes" : "") },
        ], ctx.flags.json);
        return 0;
      },
    }),

    "admin collections get": defineCommand({
      path: ["admin", "collections", "get"],
      usage: "pbc admin collections get <idOrName>",
      summary: "Show a collection.",
      args: [{ name: "idOrName", required: true }],
      flags: {},
      run: async (_input, ctx) => {
        const name = ctx.args[0];
        if (!name) {
          throw new CliError(
            "Usage: pbc admin collections get <idOrName>",
            { code: "USAGE" },
          );
        }
        const { client } = await deps.requireAdmin();
        const c = await client.getCollection(name);
        emit(ctx.flags.json, c, () => JSON.stringify(c, null, 2));
        return 0;
      },
    }),

    "admin collections create": defineCommand({
      path: ["admin", "collections", "create"],
      usage: "pbc admin collections create <name> [--type base|auth|view]",
      summary: "Create a collection.",
      args: [{ name: "name", required: true }],
      flags: {
        type: str({
          description: "Collection type. One of base, auth, view.",
          choices: ["base", "auth", "view"],
        }),
        data: str({
          description:
            "Full JSON definition — creates a collection with fields in one step.",
        }),
      },
      run: async (input, ctx) => {
        const arg = ctx.args[0] ?? input.data;
        if (!arg) {
          throw new CliError(
            "Usage: pbc admin collections create <name> [--type base|auth|view]\n" +
              "       pbc admin collections create '<json>'   (full definition, with fields)",
              { code: "USAGE" });
        }
        const { client } = await deps.requireAdmin();
        const body = arg.trimStart().startsWith("{")
          ? parseDefinition(arg)
          : { name: arg, type: input.type ?? "base" };
        const c = await client.createCollection(body);
        emit(ctx.flags.json, c, `Created collection ${c.name} (${c.id}).`);
        return 0;
      },
    }),

    "admin collections update": defineCommand({
      path: ["admin", "collections", "update"],
      usage: "pbc admin collections update <idOrName> '<json>'",
      summary: "Update a collection.",
      args: [
        { name: "idOrName", required: true },
        { name: "json", required: true },
      ],
      flags: {
        data: str({
          description: "The JSON definition, alternative to the positional.",
        }),
      },
      run: async (input, ctx) => {
        const name = ctx.args[0];
        const json = ctx.args[1] ?? input.data;
        if (!name || !json) {
          throw new CliError(
            "Usage: pbc admin collections update <idOrName> '<json>'",
            { code: "USAGE" });
        }
        const { client } = await deps.requireAdmin();
        const data = JSON.parse(json) as Record<string, unknown>;
        const c = await client.updateCollection(name, data);
        emit(ctx.flags.json, c, `Updated ${c.name}.`);
        return 0;
      },
    }),

    "admin collections rm": defineCommand({
      path: ["admin", "collections", "rm"],
      usage: "pbc admin collections rm <idOrName> [--yes]",
      summary: "Delete a collection.",
      args: [{ name: "idOrName", required: true }],
      flags: {},
      run: async (_input, ctx) => {
        const name = ctx.args[0];
        if (!name) throw new CliError(
          "Usage: pbc admin collections rm <idOrName>",
          { code: "USAGE" },
        );
        const { client } = await deps.requireAdmin();
        if (
          !await confirm(`Delete collection ${name}? This drops its data.`, {
            noInput: ctx.flags.noInput,
            yes: ctx.flags.yes,
          })
        ) {
          console.error("Aborted.");
          return 0;
        }
        await client.deleteCollection(name);
        emit(ctx.flags.json, { ok: true }, `Deleted ${name}.`);
        return 0;
      },
    }),

    "admin collections export": defineCommand({
      path: ["admin", "collections", "export"],
      usage: "pbc admin collections export [--out <file>]",
      summary: "Export all collections to JSON.",
      args: [],
      flags: {
        out: str({
          description: "Where to write the file. Defaults to collections.json.",
        }),
      },
      run: async (input, ctx) => {
        const { client } = await deps.requireAdmin();
        const cols = await client.listCollections();
        const out = input.out ?? "collections.json";
        await Deno.writeTextFile(out, JSON.stringify(cols, null, 2));
        emit(
          ctx.flags.json,
          { out, count: cols.length },
          `Exported ${cols.length} collections to ${out}.`,
        );
        return 0;
      },
    }),

    "admin collections import": defineCommand({
      path: ["admin", "collections", "import"],
      usage: "pbc admin collections import <file.json> [--delete-missing]",
      summary:
        "Import collections from JSON. --delete-missing drops collections not in the file.",
      args: [{ name: "file.json", required: true }],
      flags: {
        deleteMissing: bool({
          description: "Drop collections not in the file.",
        }),
      },
      run: async (input, ctx) => {
        const file = ctx.args[0];
        if (!file) {
          throw new CliError(
            "Usage: pbc admin collections import <file.json> [--delete-missing]",
            { code: "USAGE" });
        }
        const { client } = await deps.requireAdmin();
        const collections = JSON.parse(await Deno.readTextFile(file)) as Record<
          string,
          unknown
        >[];
        const deleteMissing = input.deleteMissing === true;
        if (deleteMissing) {
          if (
            !await confirm(
              "Import with --delete-missing will DROP collections not in the file. Continue?",
              {
                noInput: ctx.flags.noInput,
                yes: ctx.flags.yes,
              },
            )
          ) {
            console.error("Aborted.");
            return 0;
          }
        }
        await client.importCollections(collections, deleteMissing);
        emit(
          ctx.flags.json,
          { ok: true, count: collections.length },
          `Imported ${collections.length} collections.`,
        );
        return 0;
      },
    }),
  };
}
