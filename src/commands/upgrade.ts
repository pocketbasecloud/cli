import { defineCommand, type Command } from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import { describePlan } from "../ui/output.ts";
import { emit } from "../envelope.ts";

export function makeUpgradeCommands(
  deps: CloudCmdDeps,
  portalBase: string,
  write: (s: string) => void = console.log,
): Record<string, Command> {
  return {
    plan: defineCommand({
      path: ["plan"],
      usage: "pbc plan",
      summary: "Show the current plan and the upgrade link.",
      details:
        "Upgrades your account's plan. To update the pbc binary itself, " +
        "see `pbc self upgrade`.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client } = await deps.requireAuth();
        const user = await client.whoami();
        const link = `${portalBase}/plan`;
        emit(
          ctx.flags.json,
          { plan: user.plan, upgradeUrl: link },
          () =>
            [
              `Current plan: ${describePlan(user.plan)}`,
              `Manage or upgrade your plan in the portal: ${link}`,
            ].join("\n"),
          write,
        );
        return 0;
      },
    }),
  };
}
