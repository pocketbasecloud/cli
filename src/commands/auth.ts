import type { CmdCtx, Handler } from "../router.ts";
import type { CloudAuth, Config } from "../config.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError } from "../errors.ts";

export type AuthDeps = {
  loadConfig: () => Promise<Config>;
  saveConfig: (c: Config) => Promise<void>;
  makeClient: (a: CloudAuth) => ICloudClient;
  login: (o: { portalUrl: string; backendUrl: string }) => Promise<CloudAuth>;
  portalUrl: string;
  backendUrl: string;
};

export function makeAuthCommands(deps: AuthDeps): Record<string, Handler> {
  const login: Handler = async (ctx: CmdCtx) => {
    const auth = await deps.login({
      portalUrl: deps.portalUrl,
      backendUrl: deps.backendUrl,
    });
    const config = await deps.loadConfig();
    config.cloud = auth;
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
    if (!config.cloud) {
      throw new CliError("Not logged in. Run `pb cloud login`.", 4);
    }
    const user = await deps.makeClient(config.cloud).whoami();
    console.log(
      ctx.flags.json
        ? JSON.stringify(user)
        : `${user.email} — plan: ${user.plan}`,
    );
    return 0;
  };

  return {
    "cloud login": login,
    "cloud logout": logout,
    "cloud whoami": whoami,
  };
}
