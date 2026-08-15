import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { printResult } from "../ui/output.ts";
import { locationCity } from "../ui/compute.ts";

/**
 * Where a new deploy can actually land: the regions of the shared platform
 * pool for the plan the deploy will be placed against.
 *
 * Answered from deploy-context, which derives the list with the same filter as
 * server auto-selection. The orderable-server catalog is NOT it — most regions
 * the provider sells hold no server of ours, and a `--location` aimed at one
 * creates a record that dies with `noServerAvailable` seconds later. This
 * command exists so the choice can be checked before the create.
 *
 * `--project` answers for that project's owner (org-aware); without it the
 * answer is about the caller — the pre-project case, since the template flow
 * picks a region before any project record exists.
 */
export function makeLocationCommands(
  deps: CloudCmdDeps,
): Record<string, Handler> {
  const ls: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAuth();
    const projectId = ctx.flags.project as string | undefined;
    const context = await client.deployContext(projectId);

    if (ctx.flags.json) {
      // The deploy-context contract itself: raw codes plus the plan the answer
      // is for, because in an org project those come from different people.
      console.log(
        JSON.stringify({
          ownerPlan: context.ownerPlan,
          locations: context.locations ?? [],
        }),
      );
      return 0;
    }

    if (context.locations === undefined) {
      // An older backend predates the field. Nothing to list is the safe
      // failure — the platform still auto-places by capacity.
      console.log(
        "This platform backend predates deployable-region reporting. " +
          "Omit --location and the platform picks for you.",
      );
      return 0;
    }

    if (context.locations.length === 0) {
      console.log(
        `No shared-pool regions available for the ${context.ownerPlan} plan ` +
          "right now. Omit --location and the platform picks the least-loaded one.",
      );
      return 0;
    }

    console.log(`Deployable regions (plan: ${context.ownerPlan}):`);
    printResult(
      context.locations.map((code) => ({ code, city: locationCity(code) })),
      [
        { header: "CODE", get: (r) => r.code },
        { header: "REGION", get: (r) => r.city },
      ],
      false,
    );
    console.log(
      "Omit --location and the platform picks the least-loaded one.",
    );
    return 0;
  };
  return { "cloud locations": ls };
}
