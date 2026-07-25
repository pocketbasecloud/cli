import type { CmdCtx, Handler } from "../router.ts";
import type { CloudAuth, Config } from "../config.ts";
import { resolveCloudAuth } from "../config.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError } from "../errors.ts";
import { describePlan } from "../ui/output.ts";

export type AuthDeps = {
  loadConfig: () => Promise<Config>;
  saveConfig: (c: Config) => Promise<void>;
  makeClient: (a: CloudAuth) => ICloudClient;
  login: (o: { portalUrl: string; backendUrl: string }) => Promise<CloudAuth>;
  portalUrl: string;
  backendUrl: string;
  /** Stored with the token so a profile records both hosts it was made against. */
  extUrl: string;
};

export function makeAuthCommands(deps: AuthDeps): Record<string, Handler> {
  const login: Handler = async (ctx: CmdCtx) => {
    const auth = await deps.login({
      portalUrl: deps.portalUrl,
      backendUrl: deps.backendUrl,
    });
    const config = await deps.loadConfig();
    config.cloud = { ...auth, extUrl: deps.extUrl };
    await deps.saveConfig(config);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ ok: true, userId: auth.userId })
        : "Logged in.",
    );
    return 0;
  };

  const logout: Handler = async (ctx: CmdCtx) => {
    const config = await deps.loadConfig();
    config.cloud = null;
    await deps.saveConfig(config);
    console.log(ctx.flags.json ? JSON.stringify({ ok: true }) : "Logged out.");
    return 0;
  };

  const whoami: Handler = async (ctx: CmdCtx) => {
    const config = await deps.loadConfig();
    // Every other cloud command authenticates through resolveCloudAuth, which
    // also honours PB_TOKEN/PB_BACKEND_URL. whoami is the preflight probe an
    // agent runs first, so it must accept the same token-based auth rather than
    // only the saved config.cloud login.
    const auth = resolveCloudAuth(config);
    if (!auth) {
      throw new CliError("Not logged in. Run `pb cloud login`.", 4);
    }
    const user = await deps.makeClient(auth).whoami();
    console.log(
      ctx.flags.json
        ? JSON.stringify(user)
        : `${user.email} — plan: ${describePlan(user.plan)}`,
    );
    return 0;
  };

  return {
    "cloud login": login,
    "cloud logout": logout,
    "cloud whoami": whoami,
  };
}
