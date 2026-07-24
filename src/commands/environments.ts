import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { RemoveEnvResult } from "../config.ts";
import { readOwnPbJson } from "../config.ts";
import { printResult } from "../ui/output.ts";

/**
 * Say what dropping an environment did to the file beyond removing the entry,
 * so a vanished default is never a silent surprise on the next deploy.
 */
export function reportRemoval(
  result: RemoveEnvResult,
  environment: string,
  log: (msg: string) => void,
): void {
  if (!result.removed) return;
  if (result.repointedTo) {
    log(
      `Environment "${environment}" removed — "${result.repointedTo}" is now ` +
        `the default.`,
    );
  } else if (result.defaultDropped) {
    log(
      `Environment "${environment}" was the default and several remain — ` +
        `pass --env on the next deploy.`,
    );
  }
}

export function makeEnvironmentsCommands(
  deps: CloudCmdDeps,
): Record<string, Handler> {
  // Reads pb.json only: what a directory deploys where is local knowledge, and
  // answering it should not need auth or a round trip.
  const ls: Handler = async (ctx: CmdCtx) => {
    const file = await readOwnPbJson(deps.cwd());
    const rows = Object.entries(file.environments ?? {}).map(
      ([environment, entry]) => ({
        environment,
        name: entry.name,
        id: entry.id,
        default: environment === file.defaultEnvironment,
      }),
    );
    if (rows.length === 0 && !ctx.flags.json) {
      console.log(
        "No environments in ./pb.json — deploy with --name to create one.",
      );
      return 0;
    }
    printResult(rows, [
      { header: "ENVIRONMENT", get: (r) => r.environment },
      { header: "KIND", get: () => file.kind ?? "-" },
      { header: "NAME", get: (r) => r.name },
      { header: "ID", get: (r) => r.id },
      { header: "DEFAULT", get: (r) => (r.default ? "*" : "") },
    ], ctx.flags.json);
    return 0;
  };

  return { "cloud environments": ls };
}
