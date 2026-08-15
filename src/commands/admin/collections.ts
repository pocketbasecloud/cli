import type { CmdCtx, Handler } from "../../router.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";
import { printResult } from "../../ui/output.ts";
import { confirm } from "../../ui/prompt.ts";
import { isNoOpWrite } from "../../unchanged.ts";

/**
 * A collection definition passed as JSON. Rejecting a bad body here, with the
 * parser's own reason, beats letting the instance answer with a generic
 * "Failed to create collection."
 */
function parseDefinition(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new CliError(
      `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      2,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("A collection definition must be a JSON object.", 2);
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.length === 0) {
    throw new CliError('The definition needs a "name".', 2);
  }
  body.type ??= "base";
  return body;
}

export function makeCollectionsCommands(
  deps: AdminCmdDeps,
): Record<string, Handler> {
  const ls: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAdmin();
    printResult(await client.listCollections(), [
      { header: "ID", get: (c) => c.id },
      { header: "NAME", get: (c) => c.name },
      { header: "TYPE", get: (c) => c.type },
      { header: "SYSTEM", get: (c) => (c.system ? "yes" : "") },
    ], ctx.flags.json);
    return 0;
  };

  const get: Handler = async (ctx: CmdCtx) => {
    const name = ctx.args[0];
    if (!name) throw new CliError("Usage: pb collections get <idOrName>", 2);
    const { client } = await deps.requireAdmin();
    console.log(JSON.stringify(await client.getCollection(name), null, 2));
    return 0;
  };

  const create: Handler = async (ctx: CmdCtx) => {
    const arg = ctx.args[0] ?? (ctx.raw.data as string | undefined);
    if (!arg) {
      throw new CliError(
        "Usage: pb collections create <name> [--type base|auth|view]\n" +
          "       pb collections create '<json>'   (full definition, with fields)",
        2,
      );
    }
    const { client } = await deps.requireAdmin();
    // A name alone creates an empty collection, which then needs a second
    // `collections update` to gain any fields. Accepting the same JSON body
    // `update` takes makes the one-step form possible — and it is what gets
    // tried first, since a bare name that happens to be JSON is never valid.
    const body = arg.trimStart().startsWith("{")
      ? parseDefinition(arg)
      : { name: arg, type: (ctx.raw.type as string) ?? "base" };
    const c = await client.createCollection(body);
    console.log(
      ctx.flags.json
        ? JSON.stringify(c)
        : `Created collection ${c.name} (${c.id}).`,
    );
    return 0;
  };

  const update: Handler = async (ctx: CmdCtx) => {
    const name = ctx.args[0];
    const json = ctx.args[1] ?? (ctx.raw.data as string | undefined);
    if (!name || !json) {
      throw new CliError("Usage: pb collections update <idOrName> '<json>'", 2);
    }
    const { client } = await deps.requireAdmin();
    const data = JSON.parse(json) as Record<string, unknown>;
    // A collection update is the most expensive write PocketBase takes: it
    // rebuilds the collection's table and can rewrite every row in it. Pushing
    // an unchanged definition — what a CI job that re-applies its schema every
    // run does — is worth the read it takes to notice.
    if (ctx.raw.force !== true) {
      const current = await client.getCollection(name).catch(() => undefined);
      if (isNoOpWrite(current, data)) {
        console.log(
          ctx.flags.json
            ? JSON.stringify({ ...current, skipped: true })
            : `${current?.name ?? name} already matches — nothing written.`,
        );
        return 0;
      }
    }
    const c = await client.updateCollection(name, data);
    console.log(ctx.flags.json ? JSON.stringify(c) : `Updated ${c.name}.`);
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const name = ctx.args[0];
    if (!name) throw new CliError("Usage: pb collections rm <idOrName>", 2);
    const { client } = await deps.requireAdmin();
    if (
      !await confirm(`Delete collection ${name}? This drops its data.`, {
        noInput: ctx.flags.noInput,
        yes: ctx.flags.yes,
      })
    ) {
      console.log("Aborted.");
      return 0;
    }
    await client.deleteCollection(name);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleted ${name}.`,
    );
    return 0;
  };

  const exportCmd: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAdmin();
    const cols = await client.listCollections();
    const out = (ctx.raw.out as string) ?? "collections.json";
    await Deno.writeTextFile(out, JSON.stringify(cols, null, 2));
    console.log(
      ctx.flags.json
        ? JSON.stringify({ out, count: cols.length })
        : `Exported ${cols.length} collections to ${out}.`,
    );
    return 0;
  };

  const importCmd: Handler = async (ctx: CmdCtx) => {
    const file = ctx.args[0];
    if (!file) {
      throw new CliError(
        "Usage: pb collections import <file.json> [--delete-missing]",
        2,
      );
    }
    const { client } = await deps.requireAdmin();
    const collections = JSON.parse(await Deno.readTextFile(file)) as Record<
      string,
      unknown
    >[];
    const deleteMissing = ctx.raw["delete-missing"] === true;
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
        console.log("Aborted.");
        return 0;
      }
    }
    await client.importCollections(collections, deleteMissing);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ ok: true, count: collections.length })
        : `Imported ${collections.length} collections.`,
    );
    return 0;
  };

  return {
    "collections ls": ls,
    "collections get": get,
    "collections create": create,
    "collections update": update,
    "collections rm": rm,
    "collections export": exportCmd,
    "collections import": importCmd,
  };
}
