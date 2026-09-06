import { type Command, defineCommand } from "../../command.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";
import { emit } from "../../envelope.ts";
import { printResult } from "../../ui/output.ts";

export function makeCronCommands(deps: AdminCmdDeps): Record<string, Command> {
  return {
    "admin cron ls": defineCommand({
      path: ["admin", "cron", "ls"],
      usage: "pbc admin cron ls",
      summary: "List cron jobs.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client } = await deps.requireAdmin(ctx);
        printResult(await client.listCrons(), [
          { header: "ID", get: (j) => j.id },
          { header: "EXPRESSION", get: (j) => j.expression },
        ], ctx.flags.json);
        return 0;
      },
    }),

    "admin cron run": defineCommand({
      path: ["admin", "cron", "run"],
      usage: "pbc admin cron run <jobId>",
      summary: "Run a cron job now.",
      args: [{ name: "jobId", required: true }],
      flags: {},
      run: async (_input, ctx) => {
        const jobId = ctx.args[0];
        if (!jobId) throw new CliError(
          "Usage: pbc admin cron run <jobId>",
          { code: "USAGE" },
        );
        const { client } = await deps.requireAdmin(ctx);
        await client.runCron(jobId);
        emit(ctx.flags.json, { ok: true }, `Ran cron job ${jobId}.`);
        return 0;
      },
    }),
  };
}
