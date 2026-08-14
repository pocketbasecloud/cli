import type { CmdCtx, Handler } from "../../router.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError, httpError } from "../../errors.ts";
import { printResult } from "../../ui/output.ts";
import { confirm } from "../../ui/prompt.ts";

export function makeSettingsCommands(
  deps: AdminCmdDeps,
): Record<string, Handler> {
  async function section(name: string): Promise<unknown> {
    const { client } = await deps.requireAdmin();
    const all = await client.getSettings();
    return all[name];
  }

  const get: Handler = async (_ctx: CmdCtx) => {
    const { client } = await deps.requireAdmin();
    console.log(JSON.stringify(await client.getSettings(), null, 2));
    return 0;
  };

  const mail: Handler = async (_ctx: CmdCtx) => {
    console.log(JSON.stringify(await section("smtp"), null, 2));
    return 0;
  };

  const mailSet: Handler = async (ctx: CmdCtx) => {
    const json = ctx.args[0] ?? (ctx.raw.data as string | undefined);
    if (!json) throw new CliError("Usage: pb settings mail set '<json>'", 2);
    const { client } = await deps.requireAdmin();
    await client.updateSettings({ smtp: JSON.parse(json) });
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : "Updated SMTP settings.",
    );
    return 0;
  };

  const mailTest: Handler = async (ctx: CmdCtx) => {
    const to = ctx.args[0];
    if (!to) throw new CliError("Usage: pb settings mail test <email>", 2);
    const { client } = await deps.requireAdmin();
    await client.testEmail(to);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ ok: true })
        : `Test email sent to ${to}.`,
    );
    return 0;
  };

  const s3: Handler = async (_ctx: CmdCtx) => {
    console.log(JSON.stringify(await section("s3"), null, 2));
    return 0;
  };

  const s3Set: Handler = async (ctx: CmdCtx) => {
    const json = ctx.args[0] ?? (ctx.raw.data as string | undefined);
    if (!json) throw new CliError("Usage: pb settings s3 set '<json>'", 2);
    const { client } = await deps.requireAdmin();
    await client.updateSettings({ s3: JSON.parse(json) });
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : "Updated S3 settings.",
    );
    return 0;
  };

  const s3Test: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAdmin();
    await client.testS3();
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : "S3 connection OK.",
    );
    return 0;
  };

  const backupLs: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAdmin();
    printResult(await client.listBackups(), [
      { header: "KEY", get: (b) => b.key },
      { header: "SIZE", get: (b) => String(b.size) },
      { header: "MODIFIED", get: (b) => b.modified },
    ], ctx.flags.json);
    return 0;
  };

  const backupCreate: Handler = async (ctx: CmdCtx) => {
    const name = ctx.args[0] ?? "";
    const { client } = await deps.requireAdmin();
    await client.createBackup(name);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ ok: true })
        : `Backup created${name ? ` (${name})` : ""}.`,
    );
    return 0;
  };

  const backupRm: Handler = async (ctx: CmdCtx) => {
    const key = ctx.args[0];
    if (!key) throw new CliError("Usage: pb settings backup rm <key>", 2);
    const { client } = await deps.requireAdmin();
    if (
      !await confirm(`Delete backup ${key}?`, {
        noInput: ctx.flags.noInput,
        yes: ctx.flags.yes,
      })
    ) {
      console.log("Aborted.");
      return 0;
    }
    await client.deleteBackup(key);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleted backup ${key}.`,
    );
    return 0;
  };

  const backupDownload: Handler = async (ctx: CmdCtx) => {
    const key = ctx.args[0];
    if (!key) {
      throw new CliError(
        "Usage: pb settings backup download <key> [--out <file>]",
        2,
      );
    }
    const { client } = await deps.requireAdmin();
    const url = await client.backupDownloadUrl(key);
    const out = (ctx.raw.out as string) ?? key;
    const res = await fetch(url);
    if (!res.ok) throw await httpError(res, "Download");
    await Deno.writeFile(out, new Uint8Array(await res.arrayBuffer()));
    console.log(
      ctx.flags.json ? JSON.stringify({ out }) : `Downloaded ${key} → ${out}.`,
    );
    return 0;
  };

  return {
    "settings get": get,
    "settings mail": mail,
    "settings mail set": mailSet,
    "settings mail test": mailTest,
    "settings s3": s3,
    "settings s3 set": s3Set,
    "settings s3 test": s3Test,
    "settings backup ls": backupLs,
    "settings backup create": backupCreate,
    "settings backup rm": backupRm,
    "settings backup download": backupDownload,
  };
}
