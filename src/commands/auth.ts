import { type CmdCtx, type Command, defineCommand, str } from "../command.ts";
import type { CloudAuth, Config } from "../config.ts";
import {
  backendExtUrl,
  backendUrl,
  envVarName,
  resolveCloudAuth,
} from "../config.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { describePlan } from "../ui/output.ts";
import { createProgress } from "../ui/progress.ts";

export type AuthDeps = {
  loadConfig: () => Promise<Config>;
  saveConfig: (c: Config) => Promise<void>;
  makeClient: (a: CloudAuth) => ICloudClient;
  login: (o: { portalUrl: string }) => Promise<CloudAuth>;
  portalUrl: string;
};

function warnIfEnvTokenShadows(ctx: CmdCtx, effect: string): void {
  const name = envVarName("TOKEN");
  if (ctx.flags.json || !name) return;
  console.error(
    `Warning: ${name} is set and takes precedence — commands run ${effect} ` +
      `that token, not this saved login. Unset ${name} to use it.`,
  );
}

async function loginWithToken(
  deps: AuthDeps,
  userToken: string,
): Promise<CloudAuth> {
  const auth: CloudAuth = {
    backendUrl: backendUrl(),
    extUrl: backendExtUrl(),
    userToken,
    userId: "",
  };
  const user = await deps.makeClient(auth).whoami();
  return { ...auth, userId: user.id };
}

export function makeAuthCommands(deps: AuthDeps): Record<string, Command> {
  return {
    "login": defineCommand({
      path: ["login"],
      usage: "pbc login [--token <t>]",
      summary:
        "Log in to PocketBase Cloud via browser, or with an access token.",
      args: [],
      flags: {
        token: str({
          description:
            "CLI access token from the portal's Account page (skips the browser flow)",
        }),
      },
      run: async (input, ctx) => {
        const auth = input.token
          ? await loginWithToken(deps, input.token)
          : await createProgress({ silent: ctx.flags.json }).step(
            "Waiting for the browser login to finish",
            () => deps.login({ portalUrl: deps.portalUrl }),
          );
        const config = await deps.loadConfig();
        if (!auth.userId || config.cloud?.userId !== auth.userId) {
          config.currentProject = null;
        }
        config.cloud = auth;
        await deps.saveConfig(config);
        emit(ctx.flags.json, { ok: true, userId: auth.userId }, "Logged in.");
        warnIfEnvTokenShadows(ctx, "logged in as");
        return 0;
      },
    }),

    "logout": defineCommand({
      path: ["logout"],
      usage: "pbc logout",
      summary: "Log out of PocketBase Cloud.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const config = await deps.loadConfig();
        config.cloud = null;
        config.currentProject = null;
        await deps.saveConfig(config);
        emit(ctx.flags.json, { ok: true }, "Logged out.");
        warnIfEnvTokenShadows(ctx, "still authenticated as");
        return 0;
      },
    }),

    "whoami": defineCommand({
      path: ["whoami"],
      usage: "pbc whoami",
      summary: "Show the logged-in PocketBase Cloud account.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const config = await deps.loadConfig();
        const auth = resolveCloudAuth(config);
        if (!auth) {
          throw new CliError(
            "Not logged in. Run `pbc login`.",
            { code: "NOT_AUTHENTICATED" },
          );
        }
        const user = await deps.makeClient(auth).whoami();
        emit(
          ctx.flags.json,
          user,
          `${user.email} — plan: ${describePlan(user.plan)}`,
        );
        return 0;
      },
    }),
  };
}
