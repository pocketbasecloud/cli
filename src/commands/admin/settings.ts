import { type CmdCtx, type Command, defineCommand, str } from "../../command.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError, httpError } from "../../errors.ts";
import { emit } from "../../envelope.ts";
import { printResult } from "../../ui/output.ts";
import { confirm } from "../../ui/prompt.ts";

export function makeSettingsCommands(
  deps: AdminCmdDeps,
): Record<string, Command> {
  async function section(name: string, ctx: CmdCtx): Promise<unknown> {
    const { client } = await deps.requireAdmin(ctx);
    const all = await client.getSettings();
    return all[name];
  }

  return {
    "admin settings get": defineCommand({
      path: ["admin", "settings", "get"],
      usage: "pbc admin settings get",
      summary: "Show all instance settings.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client } = await deps.requireAdmin(ctx);
        const settings = await client.getSettings();
        emit(ctx.flags.json, settings, () => JSON.stringify(settings, null, 2));
        return 0;
      },
    }),

    "admin settings mail": defineCommand({
      path: ["admin", "settings", "mail"],
      usage: "pbc admin settings mail",
      summary: "Show SMTP settings.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const smtp = await section("smtp", ctx);
        emit(ctx.flags.json, smtp, () => JSON.stringify(smtp, null, 2));
        return 0;
      },
    }),

    "admin settings mail set": defineCommand({
      path: ["admin", "settings", "mail", "set"],
      usage: "pbc admin settings mail set '<json>'",
      summary: "Update SMTP settings.",
      args: [{ name: "json", required: true }],
      flags: {
        data: str({
          description: "The JSON settings, alternative to the positional.",
        }),
      },
      run: async (input, ctx) => {
        const json = ctx.args[0] ?? input.data;
        if (!json) throw new CliError(
          "Usage: pbc admin settings mail set '<json>'",
          { code: "USAGE" },
        );
        const { client } = await deps.requireAdmin(ctx);
        await client.updateSettings({ smtp: JSON.parse(json) });
        emit(ctx.flags.json, { ok: true }, "Updated SMTP settings.");
        return 0;
      },
    }),

    "admin settings mail test": defineCommand({
      path: ["admin", "settings", "mail", "test"],
      usage: "pbc admin settings mail test <email>",
      summary: "Send a test email.",
      args: [{ name: "email", required: true }],
      flags: {},
      run: async (_input, ctx) => {
        const to = ctx.args[0];
        if (!to) throw new CliError(
          "Usage: pbc admin settings mail test <email>",
          { code: "USAGE" },
        );
        const { client } = await deps.requireAdmin(ctx);
        await client.testEmail(to);
        emit(ctx.flags.json, { ok: true }, `Test email sent to ${to}.`);
        return 0;
      },
    }),

    "admin settings s3": defineCommand({
      path: ["admin", "settings", "s3"],
      usage: "pbc admin settings s3",
      summary: "Show S3 storage settings.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const s3 = await section("s3", ctx);
        emit(ctx.flags.json, s3, () => JSON.stringify(s3, null, 2));
        return 0;
      },
    }),

    "admin settings s3 set": defineCommand({
      path: ["admin", "settings", "s3", "set"],
      usage: "pbc admin settings s3 set '<json>'",
      summary: "Update S3 storage settings.",
      args: [{ name: "json", required: true }],
      flags: {
        data: str({
          description: "The JSON settings, alternative to the positional.",
        }),
      },
      run: async (input, ctx) => {
        const json = ctx.args[0] ?? input.data;
        if (!json) throw new CliError(
          "Usage: pbc admin settings s3 set '<json>'",
          { code: "USAGE" },
        );
        const { client } = await deps.requireAdmin(ctx);
        await client.updateSettings({ s3: JSON.parse(json) });
        emit(ctx.flags.json, { ok: true }, "Updated S3 settings.");
        return 0;
      },
    }),

    "admin settings s3 test": defineCommand({
      path: ["admin", "settings", "s3", "test"],
      usage: "pbc admin settings s3 test",
      summary: "Test the S3 connection.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client } = await deps.requireAdmin(ctx);
        await client.testS3();
        emit(ctx.flags.json, { ok: true }, "S3 connection OK.");
        return 0;
      },
    }),

    "admin settings backup ls": defineCommand({
      path: ["admin", "settings", "backup", "ls"],
      usage: "pbc admin settings backup ls",
      summary: "List backups.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client } = await deps.requireAdmin(ctx);
        printResult(await client.listBackups(), [
          { header: "KEY", get: (b) => b.key },
          { header: "SIZE", get: (b) => String(b.size) },
          { header: "MODIFIED", get: (b) => b.modified },
        ], ctx.flags.json);
        return 0;
      },
    }),

    "admin settings backup create": defineCommand({
      path: ["admin", "settings", "backup", "create"],
      usage: "pbc admin settings backup create [<name>]",
      summary: "Create a backup.",
      args: [{ name: "name", required: false }],
      flags: {},
      run: async (_input, ctx) => {
        const name = ctx.args[0] ?? "";
        const { client } = await deps.requireAdmin(ctx);
        await client.createBackup(name);
        emit(
          ctx.flags.json,
          { ok: true },
          `Backup created${name ? ` (${name})` : ""}.`,
        );
        return 0;
      },
    }),

    "admin settings backup rm": defineCommand({
      path: ["admin", "settings", "backup", "rm"],
      usage: "pbc admin settings backup rm <key> [--yes]",
      summary: "Delete a backup.",
      args: [{ name: "key", required: true }],
      flags: {},
      run: async (_input, ctx) => {
        const key = ctx.args[0];
        if (!key) throw new CliError(
          "Usage: pbc admin settings backup rm <key>",
          { code: "USAGE" },
        );
        const { client } = await deps.requireAdmin(ctx);
        if (
          !await confirm(`Delete backup ${key}?`, {
            noInput: ctx.flags.noInput,
            yes: ctx.flags.yes,
          })
        ) {
          console.error("Aborted.");
          return 0;
        }
        await client.deleteBackup(key);
        emit(ctx.flags.json, { ok: true }, `Deleted backup ${key}.`);
        return 0;
      },
    }),

    "admin settings backup download": defineCommand({
      path: ["admin", "settings", "backup", "download"],
      usage: "pbc admin settings backup download <key> [--out <file>]",
      summary: "Download a backup.",
      args: [{ name: "key", required: true }],
      flags: {
        out: str({
          description: "Where to write the file. Defaults to the backup key.",
        }),
      },
      run: async (input, ctx) => {
        const key = ctx.args[0];
        if (!key) {
          throw new CliError(
            "Usage: pbc admin settings backup download <key> [--out <file>]",
            { code: "USAGE" });
        }
        const { client } = await deps.requireAdmin(ctx);
        const url = await client.backupDownloadUrl(key);
        const out = input.out ?? key;
        const res = await fetch(url);
        if (!res.ok) throw await httpError(res, "Download");
        await Deno.writeFile(out, new Uint8Array(await res.arrayBuffer()));
        emit(ctx.flags.json, { out }, `Downloaded ${key} → ${out}.`);
        return 0;
      },
    }),
  };
}
