import { defineCommand, type Command } from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import { printResult } from "../ui/output.ts";
import { computeLabel } from "../ui/compute.ts";

export function makeServerCommands(
  deps: CloudCmdDeps,
): Record<string, Command> {
  const ls: Command["run"] = async (_input, ctx) => {
    const { client } = await deps.requireAuth();
    const computes = await client.listServers();
    printResult(computes, [
      { header: "ID", get: (s) => s.id },
      {
        header: "COMPUTE",
        get: (s) => computeLabel(computes.indexOf(s), s.location, s.shortKey),
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
  return {
    "compute ls": defineCommand({
      path: ["compute", "ls"],
      usage: "pbc compute ls",
      summary: "List the compute your account can deploy to.",
      details:
        "Compute is provisioned by the platform, not the CLI. This lists your\n" +
        "account's own dedicated compute — the ids `--compute <id>` accepts on a\n" +
        "deploy. The shared pool is not listed: on every plan except Pro the\n" +
        "platform picks from it by capacity and the flag is unnecessary.\n\n" +
        "`pbc server ls` is the same command under its former name.",
      args: [],
      flags: {},
      run: ls,
    }),
    "server ls": defineCommand({
      path: ["server", "ls"],
      usage: "pbc server ls",
      summary: "List the compute your account can deploy to (alias of compute ls).",
      args: [],
      flags: {},
      run: ls,
    }),
  };
}
