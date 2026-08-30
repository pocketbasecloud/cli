import { type Command, defineCommand } from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { RemoveEnvResult } from "../config.ts";
import { readOwnLinkFile } from "../config.ts";
import { printResult } from "../ui/output.ts";

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
): Record<string, Command> {
  return {
    environments: defineCommand({
      path: ["environments"],
      usage: "pbc environments",
      summary: "List the environments recorded in ./pbc.json.",
      details:
        "Shows which cloud resource each environment of this directory deploys\n" +
        "to, and which one a bare deploy targets. Reads the file only — no\n" +
        "login, no network call.\n\n" +
        "Environments are created by deploying or linking with --env:\n" +
        "  pbc frontend deploy --env staging --name web-staging",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const file = await readOwnLinkFile(deps.cwd());
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
            "No environments in ./pbc.json — deploy with --name to create one.",
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
      },
    }),
  };
}
