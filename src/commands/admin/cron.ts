import type { CmdCtx, Handler } from "../../router.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";
import { printResult } from "../../ui/output.ts";

export function makeCronCommands(deps: AdminCmdDeps): Record<string, Handler> {
  const ls: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAdmin();
    printResult(await client.listCrons(), [
      { header: "ID", get: (j) => j.id },
      { header: "EXPRESSION", get: (j) => j.expression },
    ], ctx.flags.json);
    return 0;
  };

  const run: Handler = async (ctx: CmdCtx) => {
    const jobId = ctx.args[0];
    if (!jobId) throw new CliError("Usage: pbc cron run <jobId>", 2);
    const { client } = await deps.requireAdmin();
    await client.runCron(jobId);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Ran cron job ${jobId}.`,
    );
    return 0;
  };

  return { "cron ls": ls, "cron run": run };
}
