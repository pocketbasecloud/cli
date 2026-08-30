import type { Command } from "./command.ts";

export type CommandTarget = "cloud" | "local" | "external";

const CLOUD: readonly CommandTarget[] = ["cloud"];
const LOCAL: readonly CommandTarget[] = ["local"];
const NONE: readonly CommandTarget[] = [];
const ANY: readonly CommandTarget[] = ["cloud", "local", "external"];

const BY_FAMILY: Record<string, readonly CommandTarget[]> = {
  cloud: CLOUD,
  pocketbase: CLOUD,
  frontend: CLOUD,
  backend: CLOUD,
  env: CLOUD,
  environments: CLOUD,
  locations: CLOUD,
  project: CLOUD,
  compute: CLOUD,
  server: CLOUD,
  deploy: CLOUD,
  plan: CLOUD,
  init: CLOUD,
  logs: CLOUD,
  ci: CLOUD,
  local: LOCAL,
  self: NONE,
  admin: ANY,
  login: CLOUD,
  logout: CLOUD,
  whoami: CLOUD,
};

export function targetsOf(command: Command): readonly CommandTarget[] {
  if (command.targets) return command.targets;
  const family = command.path[0];
  const targets = BY_FAMILY[family];
  if (!targets) {
    throw new Error(
      `No target layer declared for the "${family}" family — add it to ` +
        `BY_FAMILY in src/targets.ts, or set targets on the command.`,
    );
  }
  return targets;
}
