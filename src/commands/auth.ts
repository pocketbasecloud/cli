import { type CmdCtx, type Command, defineCommand, str } from "../command.ts";
import type { CloudAuth, Config } from "../config.ts";
import {
  backendExtUrl,
  backendUrl,
  envVarName,
  resolveCloudAuth,
  sessionTokenWarning,
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

const ACCESS_TOKEN_PREFIX = "pbc_";

const REVOKE_FAILED_WARNING =
  "Warning: could not revoke this login on the server. Revoke it in the portal under Account → Access tokens.";
const SESSION_NOT_ENDED_WARNING =
  "Warning: this saved login is a session token; the server login was not ended. End it in the portal with Account → Sign out everywhere.";

type RevokeOutcome = { revoked: true } | { revoked: false; reason: string };

async function revokeDeviceToken(
  deps: AuthDeps,
  auth: CloudAuth,
): Promise<RevokeOutcome> {
  try {
    const client = deps.makeClient(auth);
    const answer = await client.pbApi(
      "/api/collections/users/auth-refresh",
      {},
    );
    if (!answer.ok) {
      await answer.body?.cancel();
      return {
        revoked: false,
        reason: `checking this login answered ${answer.status}`,
      };
    }
    const id = ((await answer.json()) as { grant?: { id?: string } }).grant?.id;
    if (!id) {
      return {
        revoked: false,
        reason: "the server did not say which login this is",
      };
    }
    const revoked = await client.ext("/api/access-tokens/revoke", { id });
    await revoked.body?.cancel();
    return revoked.ok
      ? { revoked: true }
      : { revoked: false, reason: `revoking answered ${revoked.status}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      revoked: false,
      reason: `could not reach the server (${
        detail.replaceAll(auth.userToken, "<token>")
      })`,
    };
  }
}

async function revokeOnServer(
  deps: AuthDeps,
  auth: CloudAuth,
): Promise<boolean> {
  if (!auth.userToken.startsWith(ACCESS_TOKEN_PREFIX)) {
    console.error(SESSION_NOT_ENDED_WARNING);
    return false;
  }
  const outcome = await revokeDeviceToken(deps, auth);
  if (!outcome.revoked) {
    console.error(`${REVOKE_FAILED_WARNING} (${outcome.reason})`);
  }
  return outcome.revoked;
}

export function makeAuthCommands(deps: AuthDeps): Record<string, Command> {
  return {
    "login": defineCommand({
      path: ["login"],
      usage: "pbc login [--token <t>]",
      summary:
        "Log in with a code you confirm in the browser, or with an access token.",
      args: [],
      flags: {
        token: str({
          description:
            "Access token from the portal's Account page (skips the browser flow)",
        }),
      },
      run: async (input, ctx) => {
        const warning = input.token
          ? sessionTokenWarning(input.token)
          : undefined;
        if (warning) console.error(warning);
        const auth = input.token
          ? await loginWithToken(deps, input.token)
          : await createProgress({ silent: ctx.flags.json }).step(
            "Waiting for you to confirm the code in the browser",
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
        const revoked = config.cloud
          ? await revokeOnServer(deps, config.cloud)
          : false;
        config.cloud = null;
        config.currentProject = null;
        await deps.saveConfig(config);
        emit(ctx.flags.json, { ok: true, revoked }, "Logged out.");
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
          `${user.email} — plan: ${describePlan(user.plan, user.trialEndsAt)}`,
        );
        return 0;
      },
    }),
  };
}
