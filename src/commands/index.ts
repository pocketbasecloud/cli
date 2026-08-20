import type { Handler } from "../router.ts";
import { makeAuthCommands } from "./auth.ts";
import { type CloudCmdDeps, makeProjectCommands } from "./project.ts";
import { makePbCommands } from "./pb.ts";
import { makeFrontendCommands } from "./frontend.ts";
import { makeBackendCommands } from "./backend.ts";
import { makeDeployCommands } from "./deploy.ts";
import { makeEnvCommands } from "./env.ts";
import { makeEnvironmentsCommands } from "./environments.ts";
import { makeDataCommands } from "./data.ts";
import { makeLogsCommands } from "./logs.ts";
import { makeOrgCommands } from "./org.ts";
import { makeServerCommands } from "./server.ts";
import { makeLocationCommands } from "./locations.ts";
import { makeUpgradeCommands } from "./upgrade.ts";
import { makeCloudInitCommands } from "./init.ts";
import { makeCiCommands } from "./ci.ts";
import { makeLocalCommands } from "./local.ts";
import { makeSelfCommands } from "./self.ts";
import type { LocalDeps } from "../local/deps.ts";
import type { SelfDeps } from "../self/upgrade.ts";
import { hostKey } from "../../scripts/targets.ts";
import { type AdminCmdDeps } from "./admin/deps.ts";
import { makeInstanceAuthCommands } from "./admin/auth.ts";
import { makeCollectionsCommands } from "./admin/collections.ts";
import { makeRecordsCommands } from "./admin/records.ts";
import { makeRulesCommands } from "./admin/rules.ts";
import { makeAuthConfigCommands } from "./admin/authconfig.ts";
import { makeSettingsCommands } from "./admin/settings.ts";
import { makeCronCommands } from "./admin/cron.ts";
import { makeInstanceLogsCommands } from "./admin/logs.ts";
import { PocketBaseAdminClient } from "../clients/admin.ts";
import { activeProfileName } from "../resolve/profile.ts";
import {
  loadConfig,
  portalUrl,
  resolveCloudAuth,
  saveConfig,
} from "../config.ts";
import { PocketBaseCloudClient } from "../clients/cloud.ts";
import { browserLogin } from "../auth/browser-login.ts";
import { CliError } from "../errors.ts";

const PORTAL_BASE = portalUrl().replace(/\/login\/?$/, "");

export function buildCloudDeps(): CloudCmdDeps {
  return {
    requireAuth: async () => {
      const config = await loadConfig();
      const auth = resolveCloudAuth(config);
      if (!auth) throw new CliError("Not logged in. Run `pb cloud login`.", 4);
      return { client: new PocketBaseCloudClient(auth), config, auth };
    },
    loadConfig,
    saveConfig,
    cwd: () => Deno.cwd(),
  };
}

export function buildAdminDeps(): AdminCmdDeps {
  return {
    requireAdmin: async () => {
      const config = await loadConfig();
      const name = activeProfileName(config);
      if (!name || !config.profiles[name]) {
        throw new CliError("No instance selected. Run `pb use <url>`.", 2);
      }
      const profile = config.profiles[name];
      if (!profile.superuserToken) {
        throw new CliError("Not logged in. Run `pb login`.", 4);
      }
      return {
        client: new PocketBaseAdminClient(profile.url, profile.superuserToken),
        profile,
        name,
      };
    },
    loadConfig,
    saveConfig,
    makeClient: (url, token) => new PocketBaseAdminClient(url, token),
  };
}

export function buildLocalDeps(): LocalDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    cwd: () => Deno.cwd(),
    readTextFile: (p) => Deno.readTextFile(p),
    writeFile: (p, d) => Deno.writeFile(p, d),
    writeTextFile: (p, d) => Deno.writeTextFile(p, d),
    mkdir: (p) => Deno.mkdir(p, { recursive: true }),
    rename: (from, to) => Deno.rename(from, to),
    chmod: (p, mode) => Deno.chmod(p, mode),
    stat: async (p) => {
      try {
        const s = await Deno.stat(p);
        return { isFile: s.isFile };
      } catch {
        return null;
      }
    },
    remove: (p) => Deno.remove(p),
    env: (k) => Deno.env.get(k),
  };
}

export function buildSelfDeps(): SelfDeps {
  return {
    ...buildLocalDeps(),
    execPath: () => Deno.execPath(),
    hostKey: () => hostKey(),
  };
}

export function registerCommands(registry: Record<string, Handler>): void {
  const cloud = buildCloudDeps();
  const admin = buildAdminDeps();
  const pb = makePbCommands(cloud);
  const frontend = makeFrontendCommands(cloud);
  const backend = makeBackendCommands(cloud);
  Object.assign(
    registry,
    makeAuthCommands({
      loadConfig,
      saveConfig,
      makeClient: (a) => new PocketBaseCloudClient(a),
      login: (o) => browserLogin(o),
      portalUrl: portalUrl(),
    }),
    makeProjectCommands(cloud),
    pb,
    frontend,
    backend,
    // Dispatches to the three above rather than deploying anything itself, so
    // `pb cloud deploy` and `pb cloud <kind> deploy` can never drift apart.
    makeDeployCommands(cloud, {
      pocketbases: pb["cloud pb deploy"],
      frontends: frontend["cloud frontend deploy"],
      backends: backend["cloud backend deploy"],
    }),
    makeEnvCommands(cloud),
    makeEnvironmentsCommands(cloud),
    makeDataCommands(cloud),
    makeLogsCommands(cloud),
    makeOrgCommands(cloud),
    makeServerCommands(cloud),
    makeLocationCommands(cloud),
    makeUpgradeCommands(cloud, PORTAL_BASE),
    makeCloudInitCommands({ cwd: cloud.cwd }),
    makeCiCommands({ cwd: cloud.cwd }),
    makeLocalCommands(buildLocalDeps()),
    makeSelfCommands(buildSelfDeps()),
    makeInstanceAuthCommands(admin),
    makeCollectionsCommands(admin),
    makeRecordsCommands(admin),
    makeRulesCommands(admin),
    makeAuthConfigCommands(admin),
    makeSettingsCommands(admin),
    makeCronCommands(admin),
    makeInstanceLogsCommands(admin),
  );
}
