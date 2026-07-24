import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ResourceKind } from "../clients/types.ts";
import { CliError } from "../errors.ts";
import { resolveProject } from "../resolve/project.ts";
import { resolveExisting, resolveTarget } from "./deploy-helper.ts";

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function targetOf(
  ctx: CmdCtx,
): { kind: ResourceKind; type: "pocketbase" | "backend" } {
  const t = (ctx.raw.target as string) ?? "pb";
  if (t === "backend") return { kind: "backends", type: "backend" };
  if (t === "pb" || t === "pocketbase") {
    return { kind: "pocketbases", type: "pocketbase" };
  }
  throw new CliError("--target must be pb or backend.", 2);
}

export function makeEnvCommands(deps: CloudCmdDeps): Record<string, Handler> {
  /** The resource whose variables a command reads or writes. */
  async function resolveVarTarget(ctx: CmdCtx) {
    const { client, config } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput,
    });
    const { kind, type } = targetOf(ctx);
    const target = await resolveTarget(
      {
        id: ctx.raw.id as string | undefined,
        name: ctx.raw.name as string | undefined,
      },
      kind,
      deps.cwd(),
      { envFlag: ctx.raw.env as string | undefined },
    );
    const found = await resolveExisting(
      await client.listResources(kind, p.id),
      { id: target.id, name: target.name },
      {
        label: type,
        interactive: ctx.flags.interactive,
        noInput: ctx.flags.noInput,
        errorMessage: `Specify a unique --name or --id for the ${type}.`,
      },
    );
    return { client, targetId: found.id, type };
  }

  const ls: Handler = async (ctx: CmdCtx) => {
    const { client, targetId, type } = await resolveVarTarget(ctx);
    const res = await client.ext("/api/env/list", {
      target_id: targetId,
      type,
    });
    console.log(JSON.stringify(await res.json(), null, 2));
    return 0;
  };

  const set: Handler = async (ctx: CmdCtx) => {
    const kv = ctx.args[0];
    if (!kv || !kv.includes("=")) {
      throw new CliError(
        "Usage: pb cloud env set KEY=VALUE --target pb|backend --name <n>",
        2,
      );
    }
    const key = kv.slice(0, kv.indexOf("="));
    const value = kv.slice(kv.indexOf("=") + 1);
    const { client, targetId, type } = await resolveVarTarget(ctx);
    const res = await client.ext("/api/env/set", {
      target_id: targetId,
      type,
      key,
      value,
    });
    if (!res.ok) throw new CliError(`Set failed (${res.status}).`, 1);
    console.log(ctx.flags.json ? JSON.stringify({ ok: true }) : `Set ${key}.`);
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const key = ctx.args[0];
    if (!key) {
      throw new CliError(
        "Usage: pb cloud env rm KEY --target pb|backend --name <n>",
        2,
      );
    }
    const { client, targetId, type } = await resolveVarTarget(ctx);
    const res = await client.ext("/api/env/delete", {
      target_id: targetId,
      type,
      key,
    });
    if (!res.ok) throw new CliError(`Delete failed (${res.status}).`, 1);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Removed ${key}.`,
    );
    return 0;
  };

  const importCmd: Handler = async (ctx: CmdCtx) => {
    const file = ctx.args[0];
    if (!file) {
      throw new CliError(
        "Usage: pb cloud env import <.env> --target pb|backend --name <n>",
        2,
      );
    }
    const vars = parseDotenv(await Deno.readTextFile(file));
    const { client, targetId, type } = await resolveVarTarget(ctx);
    const res = await client.ext("/api/env/bulk-set", {
      target_id: targetId,
      type,
      vars,
    });
    if (!res.ok) throw new CliError(`Import failed (${res.status}).`, 1);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ imported: Object.keys(vars).length })
        : `Imported ${Object.keys(vars).length} vars.`,
    );
    return 0;
  };

  return {
    "cloud env ls": ls,
    "cloud env set": set,
    "cloud env rm": rm,
    "cloud env import": importCmd,
  };
}
