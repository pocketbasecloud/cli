import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ResourceKind } from "../clients/types.ts";
import { CliError, httpError } from "../errors.ts";
import { resolveProject } from "../resolve/project.ts";
import {
  envDigest,
  envStateKey,
  forgetEnvDigest,
  recordEnvDigest,
} from "../env-state.ts";
import { resolveExisting, resolveTarget } from "./deploy-helper.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";

/**
 * Pull the variable names out of the /api/env/list envelope. The route wraps
 * them as `details.variables` — an object keyed by name — and the values are
 * ciphertext the CLI has no key for, so only the names are worth surfacing. An
 * older/flatter `{ variables }` shape is tolerated so the CLI need not move in
 * lockstep with the platform.
 */
export function envKeysOf(body: unknown): string[] {
  const b = (body ?? {}) as {
    details?: { variables?: Record<string, unknown> };
    variables?: Record<string, unknown>;
  };
  const vars = b.details?.variables ?? b.variables ?? {};
  return Object.keys(vars).sort();
}

/**
 * Keys the platform removed because `prune` was set. The route reports them as
 * `details.pruned`; a flatter `{ pruned }` is tolerated for the same reason
 * `envKeysOf` tolerates one, and anything else reads as "nothing removed".
 */
export function prunedKeysOf(body: unknown): string[] {
  const b = (body ?? {}) as {
    details?: { pruned?: unknown };
    pruned?: unknown;
  };
  const pruned = b.details?.pruned ?? b.pruned;
  return Array.isArray(pruned) ? pruned.map(String) : [];
}

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
      noInput: ctx.flags.noInput || ctx.flags.json,
      log: ctx.flags.json ? undefined : (m) => console.log(m),
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
    const res = await client.pbApi("/api/env/list", {
      target_id: targetId,
      type,
    });
    if (!res.ok) throw await httpError(res, "List");
    // Values come back encrypted, so `ls` reports names only — a table for
    // humans, a flat [{ key }] array under --json to match every other `ls`.
    const keys = envKeysOf(await res.json());
    printResult(
      keys.map((key) => ({ key })),
      [{ header: "KEY", get: (r) => r.key }],
      ctx.flags.json,
    );
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
    const res = await client.pbApi("/api/env/set", {
      target_id: targetId,
      type,
      key,
      value,
    });
    if (!res.ok) throw await httpError(res, "Set");
    // The cloud store no longer matches whatever a deploy last pushed, so the
    // next deploy must not trust its digest and skip.
    await forgetEnvDigest(envStateKey(type, targetId), deps.envStatePath?.());
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
    const res = await client.pbApi("/api/env/delete", {
      target_id: targetId,
      type,
      key,
    });
    if (!res.ok) throw await httpError(res, "Delete");
    await forgetEnvDigest(envStateKey(type, targetId), deps.envStatePath?.());
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
    // Merging is the default: a cloud-only key is usually a secret set from the
    // portal, not a leftover. --delete-missing makes the file the whole truth.
    const deleteMissing = ctx.raw["delete-missing"] === true;
    if (deleteMissing) {
      const ok = await confirm(
        `Import with --delete-missing will REMOVE cloud variables that ${file} does not list. Continue?`,
        { noInput: ctx.flags.noInput, yes: ctx.flags.yes },
      );
      if (!ok) {
        console.log("Aborted.");
        return 0;
      }
    }
    const { client, targetId, type } = await resolveVarTarget(ctx);
    // The route validates with validateSetEnvRequest: the bulk field is
    // `variables`, and anything else reads as "neither key+value nor bulk".
    const res = await client.ext("/api/env/bulk-set", {
      target_id: targetId,
      type,
      variables: vars,
      prune: deleteMissing,
    });
    if (!res.ok) throw await httpError(res, "Import");
    // An import writes exactly what a deploy's push writes, so it records the
    // same digest rather than invalidating: importing the file a deploy would
    // have pushed leaves that deploy nothing to do.
    await recordEnvDigest(
      envStateKey(type, targetId),
      await envDigest(vars, deleteMissing),
      deps.envStatePath?.(),
    );
    const removed = prunedKeysOf(await res.json());
    const imported = Object.keys(vars).length;
    if (ctx.flags.json) {
      console.log(JSON.stringify({ imported, removed }));
    } else {
      console.log(`Imported ${imported} vars.`);
      if (removed.length > 0) {
        console.log(`Removed ${removed.length}: ${removed.join(", ")}.`);
      }
    }
    return 0;
  };

  return {
    "cloud env ls": ls,
    "cloud env set": set,
    "cloud env rm": rm,
    "cloud env import": importCmd,
  };
}
