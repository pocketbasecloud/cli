import type { CmdCtx, Handler } from "../router.ts";
import type { CloudAuth, Config } from "../config.ts";
import { envVarName, resolveCloudAuth } from "../config.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError } from "../errors.ts";
import { describePlan } from "../ui/output.ts";
import { createProgress } from "../ui/progress.ts";

export type AuthDeps = {
  loadConfig: () => Promise<Config>;
  saveConfig: (c: Config) => Promise<void>;
  makeClient: (a: CloudAuth) => ICloudClient;
  login: (o: { portalUrl: string }) => Promise<CloudAuth>;
  portalUrl: string;
};

/**
 * `PBC_TOKEN` overrides the saved login for every other command, so without this
 * `login` prints "Logged in." and `logout` prints "Logged out." while the very
 * next command authenticates as the env token — a 401 or a wrong-account write
 * with nothing on screen to explain either.
 */
function warnIfEnvTokenShadows(ctx: CmdCtx, effect: string): void {
  // Named, not assumed: a shell still exporting the pre-0.6.0 PB_TOKEN must be
  // told to unset that one.
  const name = envVarName("TOKEN");
  if (ctx.flags.json || !name) return;
  console.error(
    `Warning: ${name} is set and takes precedence — commands run ${effect} ` +
      `that token, not this saved login. Unset ${name} to use it.`,
  );
}

export function makeAuthCommands(deps: AuthDeps): Record<string, Handler> {
  const login: Handler = async (ctx: CmdCtx) => {
    // The browser is where the time goes: this waits for a human to finish an
    // OAuth round trip, and until the callback lands there is nothing to show.
    const auth = await createProgress({ silent: ctx.flags.json }).step(
      "Waiting for the browser login to finish",
      () => deps.login({ portalUrl: deps.portalUrl }),
    );
    const config = await deps.loadConfig();
    // Logging in as someone else inherits the previous account's project id, and
    // every flagless command then fails on a project this user cannot see. An
    // absent prior login counts as "differs": the selection's owner is unknown,
    // so it cannot be assumed to be this one. So does an unidentified login —
    // a callback with no user id makes two different accounts compare equal
    // (both ""), which is exactly the case this clearing exists for.
    if (!auth.userId || config.cloud?.userId !== auth.userId) {
      config.currentProject = null;
    }
    config.cloud = auth;
    await deps.saveConfig(config);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ ok: true, userId: auth.userId })
        : "Logged in.",
    );
    warnIfEnvTokenShadows(ctx, "logged in as");
    return 0;
  };

  const logout: Handler = async (ctx: CmdCtx) => {
    const config = await deps.loadConfig();
    config.cloud = null;
    // The selected project belongs to the account being logged out of. Leaving
    // it behind means the next login — typically a *different* account, since
    // that is why one logs out — inherits a project id it cannot see, and every
    // flagless command fails on a stale id instead of asking for a project.
    config.currentProject = null;
    await deps.saveConfig(config);
    console.log(ctx.flags.json ? JSON.stringify({ ok: true }) : "Logged out.");
    warnIfEnvTokenShadows(ctx, "still authenticated as");
    return 0;
  };

  const whoami: Handler = async (ctx: CmdCtx) => {
    const config = await deps.loadConfig();
    // Every other cloud command authenticates through resolveCloudAuth, which
    // also honours PBC_TOKEN. whoami is the preflight probe an agent runs first,
    // so it must accept the same token-based auth rather than only the saved
    // config.cloud login.
    const auth = resolveCloudAuth(config);
    if (!auth) {
      throw new CliError("Not logged in. Run `pbc cloud login`.", 4);
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
