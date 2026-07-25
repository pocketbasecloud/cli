import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { printResult } from "../ui/output.ts";

/**
 * Servers are hidden infrastructure — the CLI never creates or deletes one.
 * Listing them exists because `cloud pb deploy --server <id>` needs an id, and
 * without this the only place to find one was the portal.
 */
export function makeServerCommands(
  deps: CloudCmdDeps,
): Record<string, Handler> {
  const ls: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAuth();
    printResult(await client.listServers(), [
      { header: "ID", get: (s) => s.id },
      { header: "NAME", get: (s) => s.name },
      { header: "STATUS", get: (s) => s.status },
      { header: "LOCATION", get: (s) => s.location },
      { header: "OWNERSHIP", get: (s) => s.ownership },
      {
        header: "SPEC",
        get: (s) => s.cores ? `${s.cores}c/${s.memory}GB` : "",
      },
    ], ctx.flags.json);
    return 0;
  };
  return { "cloud server ls": ls };
}
