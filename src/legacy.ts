import type { Command, CommandRegistry } from "./command.ts";

export type LegacyRename = { old: string; new: string };

export const LEGACY_RENAMES: LegacyRename[] = [
  { old: "cloud pb", new: "pocketbase" },
  { old: "cloud frontend", new: "frontend" },
  { old: "cloud backend", new: "backend" },
  { old: "cloud deploy", new: "deploy" },
  { old: "cloud env", new: "env" },
  { old: "cloud environments", new: "environments" },
  { old: "cloud locations", new: "locations" },
  { old: "cloud project", new: "project" },
  { old: "cloud org", new: "org" },
  { old: "cloud compute", new: "compute" },
  { old: "cloud server", new: "server" },
  { old: "cloud upgrade", new: "plan" },
  { old: "cloud init", new: "init" },
  { old: "init", new: "local init" },
  { old: "install", new: "local install" },
  { old: "versions", new: "local versions" },
  { old: "which", new: "local which" },
  { old: "upgrade", new: "self upgrade" },
  { old: "collections", new: "admin collections" },
  { old: "records", new: "admin records" },
  { old: "rules", new: "admin rules" },
  { old: "settings", new: "admin settings" },
  { old: "cron", new: "admin cron" },
  { old: "auth", new: "admin auth" },
  { old: "use", new: "admin use" },
  { old: "cloud logs", new: "logs" },
  { old: "cloud ci", new: "ci" },
  { old: "cloud login", new: "login" },
  { old: "cloud logout", new: "logout" },
  { old: "cloud whoami", new: "whoami" },
];

export function applyLegacyAliases(
  registry: CommandRegistry,
  renames: LegacyRename[] = LEGACY_RENAMES,
): void {
  const canonical = Object.keys(registry).filter(
    (k) => registry[k].path.join(" ") === k,
  );
  const additions: Record<string, Command> = {};
  for (const { old, new: next } of renames) {
    const oldTokens = old.split(" ");
    const newTokens = next.split(" ");
    for (const key of canonical) {
      const tokens = key.split(" ");
      if (
        tokens.length >= newTokens.length &&
        tokens.slice(0, newTokens.length).join(" ") === next
      ) {
        const aliasKey = [...oldTokens, ...tokens.slice(newTokens.length)].join(
          " ",
        );
        if (!registry[aliasKey] && !additions[aliasKey]) {
          additions[aliasKey] = registry[key];
        }
      }
    }
  }
  Object.assign(registry, additions);
}
