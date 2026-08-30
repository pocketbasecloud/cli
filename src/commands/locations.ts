import { defineCommand, type Command } from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import { emit } from "../envelope.ts";
import { renderTable } from "../ui/output.ts";
import { locationCity } from "../ui/compute.ts";

export function makeLocationCommands(
  deps: CloudCmdDeps,
): Record<string, Command> {
  return {
    locations: defineCommand({
      path: ["locations"],
      usage: "pbc locations",
      summary: "List the regions a deploy can actually land in.",
      details:
        "The regions of the shared platform pool for the plan a deploy is placed\n" +
        "against — what `--location <loc>` accepts on `pocketbase create` and\n" +
        "`frontend deploy`. Not the provider catalog: most regions a\n" +
        "provider sells hold no server of ours, and a deploy aimed at one fails\n" +
        "with `noServerAvailable`.\n\n" +
        "With `--project`, the answer is for that project's owner (org-aware);\n" +
        "without it, for the caller.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client } = await deps.requireAuth();
        const projectId = ctx.flags.project;
        const context = await client.deployContext(projectId);

        emit(
          ctx.flags.json,
          { ownerPlan: context.ownerPlan, locations: context.locations ?? [] },
          () => {
            if (context.locations === undefined) {
              return "This platform backend predates deployable-region reporting. " +
                "Omit --location and the platform picks for you.";
            }
            if (context.locations.length === 0) {
              return `No shared-pool regions available for the ${context.ownerPlan} ` +
                "plan right now. Omit --location and the platform picks the " +
                "least-loaded one.";
            }
            return [
              `Deployable regions (plan: ${context.ownerPlan}):`,
              renderTable(
                context.locations.map((code) => ({
                  code,
                  city: locationCity(code),
                })),
                [
                  { header: "CODE", get: (r) => r.code },
                  { header: "REGION", get: (r) => r.city },
                ],
              ),
              "Omit --location and the platform picks the least-loaded one.",
            ].join("\n");
          },
        );
        return 0;
      },
    }),
  };
}
