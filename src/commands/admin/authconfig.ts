import {
  str,
  type Command,
  defineCommand,
} from "../../command.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";
import { emit } from "../../envelope.ts";

const AUTH_FIELDS = [
  "authRule",
  "manageRule",
  "authAlert",
  "oauth2",
  "passwordAuth",
  "mfa",
  "otp",
  "verificationTemplate",
  "resetPasswordTemplate",
];

export function makeAuthConfigCommands(
  deps: AdminCmdDeps,
): Record<string, Command> {
  return {
    "admin auth": defineCommand({
      path: ["admin", "auth"],
      usage: "pbc admin auth <collection> config [--set '<field>=<json>']",
      summary: "View or edit an auth collection's auth-related settings.",
      details: `Without --set, prints the current value of: authRule, manageRule, authAlert,
oauth2, passwordAuth, mfa, otp, verificationTemplate, resetPasswordTemplate.

--set '<field>=<json>' replaces that field entirely, so run without --set
first when the field already has content you need to keep (e.g.
oauth2.providers) and include it in the json. Collection and field names as
in the admin UI.

  pbc admin auth users config
  pbc admin auth users config --set 'passwordAuth={"enabled":true,"identityFields":["email"]}'`,
      args: [
        { name: "collection", required: true },
        {
          name: "config",
          required: true,
          description: "Literal subcommand keyword",
        },
      ],
      flags: {
        set: str({
          description: "Replace one field entirely, as '<field>=<json>'.",
        }),
      },
      run: async (input, ctx) => {
        const collection = ctx.args[0];
        const sub = ctx.args[1];
        if (!collection || sub !== "config") {
          throw new CliError(
            "Usage: pbc admin auth <collection> config [--set '<field>=<json>']",
            { code: "USAGE" });
        }
        const { client } = await deps.requireAdmin(ctx);
        const c = await client.getCollection(collection);
        if (c.type !== "auth") {
          throw new CliError(
            `Collection ${collection} is not an auth collection.`,
            { code: "INVALID_VALUE" },
          );
        }

        if (input.set) {
          const eq = input.set.indexOf("=");
          if (eq === -1) throw new CliError(
            "--set expects <field>=<json>.",
            { code: "USAGE" },
          );
          const field = input.set.slice(0, eq);
          const value = JSON.parse(input.set.slice(eq + 1));
          await client.updateCollection(collection, { [field]: value });
          emit(
            ctx.flags.json,
            { ok: true, field },
            `Updated ${field} on ${collection}.`,
          );
          return 0;
        }

        const view: Record<string, unknown> = { type: c.type };
        for (const f of AUTH_FIELDS) {
          if (f in c) view[f] = c[f];
        }
        emit(ctx.flags.json, view, () => JSON.stringify(view, null, 2));
        return 0;
      },
    }),
  };
}
