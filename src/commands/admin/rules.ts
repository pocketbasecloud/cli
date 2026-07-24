import type { CmdCtx, Handler } from "../../router.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";

const RULE_FLAGS: [flag: string, field: string][] = [
  ["list-rule", "listRule"],
  ["view-rule", "viewRule"],
  ["create-rule", "createRule"],
  ["update-rule", "updateRule"],
  ["delete-rule", "deleteRule"],
];

export function makeRulesCommands(deps: AdminCmdDeps): Record<string, Handler> {
  const get: Handler = async (ctx: CmdCtx) => {
    const name = ctx.args[0];
    if (!name) throw new CliError("Usage: pb rules get <collection>", 2);
    const { client } = await deps.requireAdmin();
    const c = await client.getCollection(name);
    const rules = {
      listRule: c.listRule,
      viewRule: c.viewRule,
      createRule: c.createRule,
      updateRule: c.updateRule,
      deleteRule: c.deleteRule,
    };
    console.log(JSON.stringify(rules, null, 2));
    return 0;
  };

  const set: Handler = async (ctx: CmdCtx) => {
    const name = ctx.args[0];
    if (!name) {
      throw new CliError(
        "Usage: pb rules set <collection> --list-rule '<expr>' …",
        2,
      );
    }
    const data: Record<string, unknown> = {};
    for (const [flag, field] of RULE_FLAGS) {
      const val = ctx.raw[flag];
      if (typeof val === "string") data[field] = val === "null" ? null : val;
    }
    if (Object.keys(data).length === 0) {
      throw new CliError(
        "Provide at least one of --list-rule/--view-rule/--create-rule/--update-rule/--delete-rule (use 'null' to clear).",
        2,
      );
    }
    const { client } = await deps.requireAdmin();
    await client.updateCollection(name, data);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ ok: true, updated: Object.keys(data) })
        : `Updated rules on ${name}.`,
    );
    return 0;
  };

  return { "rules get": get, "rules set": set };
}
