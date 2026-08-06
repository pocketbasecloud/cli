import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { printResult } from "../ui/output.ts";
import { computeLabel } from "../ui/compute.ts";

/**
 * Compute is hidden infrastructure — the CLI never creates or deletes any.
 * Listing it exists because `cloud pb deploy --compute <id>` needs an id, and
 * without this the only place to find one was the portal.
 *
 * Only the account's own dedicated compute is listed; the shared platform pool
 * is auto-selected by capacity and is not something to name.
 *
 * `cloud server ls` is kept as an alias: the platform's records are called
 * servers, and that was this command's name before the user-facing vocabulary
 * settled on "compute".
 */
export function makeServerCommands(
  deps: CloudCmdDeps,
): Record<string, Handler> {
  const ls: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAuth();
    // Oldest-first, which is the order every compute picker numbers by — so
    // "Compute 2" here is "Compute 2" in the portal and in a deploy's menu.
    const computes = await client.listServers();
    printResult(computes, [
      { header: "ID", get: (s) => s.id },
      {
        header: "COMPUTE",
        get: (s) => computeLabel(computes.indexOf(s), s.location),
      },
      { header: "STATUS", get: (s) => s.status },
      { header: "LOCATION", get: (s) => s.location },
      {
        header: "SPEC",
        get: (s) => s.cores ? `${s.cores}c/${s.memory}GB` : "",
      },
    ], ctx.flags.json);
    return 0;
  };
  return { "cloud compute ls": ls, "cloud server ls": ls };
}
