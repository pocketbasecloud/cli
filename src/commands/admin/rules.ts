import {
  str,
  type Command,
  defineCommand,
} from "../../command.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";
import { emit } from "../../envelope.ts";

const RULE_FLAGS = [
  "listRule",
  "viewRule",
  "createRule",
  "updateRule",
  "deleteRule",
];

export function makeRulesCommands(deps: AdminCmdDeps): Record<string, Command> {
  return {
    "admin rules get": defineCommand({
      path: ["admin", "rules", "get"],
      usage: "pbc admin rules get <collection>",
      summary: "Show API rules.",
      args: [{ name: "collection", required: true }],
      flags: {},
      run: async (_input, ctx) => {
        const name = ctx.args[0];
        if (!name) throw new CliError(
          "Usage: pbc admin rules get <collection>",
          { code: "USAGE" },
        );
        const { client } = await deps.requireAdmin();
        const c = await client.getCollection(name);
        const rules = {
          listRule: c.listRule,
          viewRule: c.viewRule,
          createRule: c.createRule,
          updateRule: c.updateRule,
          deleteRule: c.deleteRule,
        };
        emit(ctx.flags.json, rules, () => JSON.stringify(rules, null, 2));
        return 0;
      },
    }),

    "admin rules set": defineCommand({
      path: ["admin", "rules", "set"],
      usage:
        "pbc admin rules set <collection> [--list-rule <expr>] [--view-rule <expr>] " +
        "[--create-rule <expr>] [--update-rule <expr>] [--delete-rule <expr>]",
      summary: "Update API rules. Pass 'null' as a value to clear a rule.",
      args: [{ name: "collection", required: true }],
      flags: {
        listRule: str({
          description: "The list rule expression. 'null' clears it.",
        }),
        viewRule: str({
          description: "The view rule expression. 'null' clears it.",
        }),
        createRule: str({
          description: "The create rule expression. 'null' clears it.",
        }),
        updateRule: str({
          description: "The update rule expression. 'null' clears it.",
        }),
        deleteRule: str({
          description: "The delete rule expression. 'null' clears it.",
        }),
      },
      run: async (input, ctx) => {
        const name = ctx.args[0];
        if (!name) {
          throw new CliError(
            "Usage: pbc admin rules set <collection> --list-rule '<expr>' …",
            { code: "USAGE" });
        }
        const data: Record<string, unknown> = {};
        for (const field of RULE_FLAGS) {
          const val = (input as Record<string, unknown>)[field];
          if (typeof val === "string") data[field] = val === "null" ? null : val;
        }
        if (Object.keys(data).length === 0) {
          throw new CliError(
            "Provide at least one of --list-rule/--view-rule/--create-rule/--update-rule/--delete-rule (use 'null' to clear).",
            { code: "USAGE" });
        }
        const { client } = await deps.requireAdmin();
        await client.updateCollection(name, data);
        emit(
          ctx.flags.json,
          { ok: true, updated: Object.keys(data) },
          `Updated rules on ${name}.`,
        );
        return 0;
      },
    }),
  };
}
