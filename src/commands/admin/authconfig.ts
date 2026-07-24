import type { CmdCtx, Handler } from "../../router.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";

// Auth-relevant collection fields surfaced/edited by this command.
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
): Record<string, Handler> {
  const auth: Handler = async (ctx: CmdCtx) => {
    const collection = ctx.args[0];
    const sub = ctx.args[1];
    if (!collection || sub !== "config") {
      throw new CliError(
        "Usage: pb auth <collection> config [--set '<field>=<json>']",
        2,
      );
    }
    const { client } = await deps.requireAdmin();
    const c = await client.getCollection(collection);
    if (c.type !== "auth") {
      throw new CliError(
        `Collection ${collection} is not an auth collection.`,
        3,
      );
    }

    const setExpr = ctx.raw.set as string | undefined;
    if (setExpr) {
      const eq = setExpr.indexOf("=");
      if (eq === -1) throw new CliError("--set expects <field>=<json>.", 2);
      const field = setExpr.slice(0, eq);
      const value = JSON.parse(setExpr.slice(eq + 1));
      await client.updateCollection(collection, { [field]: value });
      console.log(
        ctx.flags.json
          ? JSON.stringify({ ok: true, field })
          : `Updated ${field} on ${collection}.`,
      );
      return 0;
    }

    const view: Record<string, unknown> = { type: c.type };
    for (const f of AUTH_FIELDS) {
      if (f in c) view[f] = c[f];
    }
    console.log(JSON.stringify(view, null, 2));
    return 0;
  };

  return { "auth": auth };
}
