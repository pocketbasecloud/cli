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

With --set '<field>=<json>', replaces that one field's value entirely — run
without --set first if the field (e.g. oauth2.providers) already has content
you need to keep, and include it in the json you send.

Examples:
  pbc admin auth users config
  pbc admin auth users config --set 'passwordAuth={"enabled":true,"identityFields":["email"]}'

  Enable Google sign-in on the "users" collection (get clientId/clientSecret
  from a Google Cloud OAuth 2.0 Client ID, with authorized redirect URI
  <your-instance-url>/api/oauth2-redirect):
    pbc admin auth users config --set 'oauth2={"enabled":true,"providers":[{"name":"google","clientId":"<GOOGLE_CLIENT_ID>.apps.googleusercontent.com","clientSecret":"<GOOGLE_CLIENT_SECRET>"}]}'

  Add Google alongside an existing provider — include every provider you
  want to keep, since the json replaces the whole oauth2 field:
    pbc admin auth users config --set 'oauth2={"enabled":true,"providers":[{"name":"github","clientId":"<GITHUB_CLIENT_ID>","clientSecret":"<GITHUB_CLIENT_SECRET>"},{"name":"google","clientId":"<GOOGLE_CLIENT_ID>.apps.googleusercontent.com","clientSecret":"<GOOGLE_CLIENT_SECRET>"}]}'`,
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
        const { client } = await deps.requireAdmin();
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
