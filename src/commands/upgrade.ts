import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { describePlan } from "../ui/output.ts";

export function makeUpgradeCommands(
  deps: CloudCmdDeps,
  portalBase: string,
  write: (s: string) => void = console.log,
): Record<string, Handler> {
  const upgrade: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAuth();
    const user = await client.whoami();
    const link = `${portalBase}/plan`;
    if (ctx.flags.json) {
      write(JSON.stringify({ plan: user.plan, upgradeUrl: link }));
    } else {
      write(`Current plan: ${describePlan(user.plan)}`);
      write(`Manage or upgrade your plan in the portal: ${link}`);
    }
    return 0;
  };
  return { "cloud upgrade": upgrade };
}
