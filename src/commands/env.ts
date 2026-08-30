import {
  bool,
  type CmdCtx,
  type Command,
  defineCommand,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import { CliError, httpError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { type KindSpec, kindByAlias, kindsWith } from "../kinds.ts";
import { resolveResourceTarget } from "../resolve/target.ts";
import {
  envDigest,
  envStateKey,
  forgetEnvDigest,
  recordEnvDigest,
} from "../env-state.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";

export function envKeysOf(body: unknown): string[] {
  const b = (body ?? {}) as {
    details?: { variables?: Record<string, unknown> };
    variables?: Record<string, unknown>;
  };
  const vars = b.details?.variables ?? b.variables ?? {};
  return Object.keys(vars).sort();
}

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

const ENV_KINDS = kindsWith("env");
const ENV_NOUNS = ENV_KINDS.map((k) => k.noun);

function targetOf(input: { target?: string }): KindSpec {
  const spec = kindByAlias(input.target ?? ENV_NOUNS[0]);
  if (!spec || !spec.env) {
    throw new CliError(
      `--target must be ${ENV_NOUNS.join(" or ")}.`,
      { code: "USAGE" },
    );
  }
  return spec;
}

export function makeEnvCommands(deps: CloudCmdDeps): Record<string, Command> {
  async function resolveVarTarget(
    ctx: CmdCtx,
    input: { target?: string; name?: string; id?: string; env?: string },
    explicit: boolean,
  ) {
    const { client, config } = await deps.requireAuth();
    const spec = targetOf(input);
    const { resource } = await resolveResourceTarget({
      client,
      spec,
      cwd: deps.cwd(),
      name: input.name,
      id: input.id,
      envFlag: input.env,
      projectFilter: ctx.flags.project,
      config,
      explicit,
      noInput: ctx.flags.noInput || ctx.flags.json,
      io: deps.io,
      log: (m) => console.error(m),
    });
    return {
      client,
      targetId: resource.id,
      type: spec.apiType as "pocketbase" | "backend",
    };
  }

  const targetFlag = str({
    description: `${ENV_NOUNS.join(" or ")} — which kind's variables.`,
    choices: ENV_NOUNS,
    required: true,
  });
  const nameFlag = str({
    description: "Which resource's variables. Asked for when omitted.",
    required: true,
  });
  const idFlag = str({
    description: "The resource's id, alternative to --name.",
  });
  const envFlag = str({
    description: "Which pbc.json environment to target.",
  });

  return {
    "env ls": defineCommand({
      path: ["env", "ls"],
      usage: `pbc env ls --target ${ENV_NOUNS.join("|")} --name <n> [--env <name>]`,
      summary: "List environment variables.",
      details:
        "Names only. The platform stores values encrypted and its list endpoint\n" +
        "never returns plaintext, so there is nothing for the CLI to show —\n" +
        "read a value from the app itself, or overwrite it with `env set`.\n" +
        "Without --name/--id, a terminal offers a picker.",
      args: [],
      flags: {
        target: targetFlag,
        name: nameFlag,
        id: idFlag,
        env: envFlag,
      },
      run: async (input, ctx) => {
        const { client, targetId, type } = await resolveVarTarget(ctx, input, false);
        const res = await client.pbApi("/api/env/list", {
          target_id: targetId,
          type,
        });
        if (!res.ok) throw await httpError(res, "List");
        const keys = envKeysOf(await res.json());
        printResult(
          keys.map((key) => ({ key })),
          [{ header: "KEY", get: (r) => r.key }],
          ctx.flags.json,
        );
        return 0;
      },
    }),

    "env set": defineCommand({
      path: ["env", "set"],
      usage: `pbc env set KEY=VALUE --target ${ENV_NOUNS.join("|")} --name <n> [--env <name>]`,
      summary: "Set an environment variable.",
      details: "Without --name/--id, a terminal offers a picker.",
      args: [{ name: "KEY=VALUE", required: true }],
      flags: {
        target: targetFlag,
        name: nameFlag,
        id: idFlag,
        env: envFlag,
      },
      run: async (input, ctx) => {
        const kv = ctx.args[0];
        if (!kv || !kv.includes("=")) {
          throw new CliError(
            `Usage: pbc env set KEY=VALUE --target ${ENV_NOUNS.join("|")} --name <n>`,
            { code: "USAGE" });
        }
        const key = kv.slice(0, kv.indexOf("="));
        const value = kv.slice(kv.indexOf("=") + 1);
        const { client, targetId, type } = await resolveVarTarget(ctx, input, true);
        const res = await client.pbApi("/api/env/set", {
          target_id: targetId,
          type,
          key,
          value,
        });
        if (!res.ok) throw await httpError(res, "Set");
        await forgetEnvDigest(envStateKey(type, targetId), deps.envStatePath?.());
        emit(ctx.flags.json, { ok: true }, `Set ${key}.`);
        return 0;
      },
    }),

    "env rm": defineCommand({
      path: ["env", "rm"],
      usage: `pbc env rm KEY --target ${ENV_NOUNS.join("|")} --name <n> [--env <name>]`,
      summary: "Remove an environment variable.",
      details: "Without --name/--id, a terminal offers a picker.",
      args: [{ name: "KEY", required: true }],
      flags: {
        target: targetFlag,
        name: nameFlag,
        id: idFlag,
        env: envFlag,
      },
      run: async (input, ctx) => {
        const key = ctx.args[0];
        if (!key) {
          throw new CliError(
            `Usage: pbc env rm KEY --target ${ENV_NOUNS.join("|")} --name <n>`,
            { code: "USAGE" });
        }
        const { client, targetId, type } = await resolveVarTarget(ctx, input, true);
        const res = await client.pbApi("/api/env/delete", {
          target_id: targetId,
          type,
          key,
        });
        if (!res.ok) throw await httpError(res, "Delete");
        await forgetEnvDigest(envStateKey(type, targetId), deps.envStatePath?.());
        emit(ctx.flags.json, { ok: true }, `Removed ${key}.`);
        return 0;
      },
    }),

    "env import": defineCommand({
      path: ["env", "import"],
      usage:
        `pbc env import <.env> --target ${ENV_NOUNS.join("|")} --name <n> [--delete-missing] [--env <name>]`,
      summary: "Bulk-import variables from a .env file.",
      details: `Merges by default: keys in the file are written, keys only in the cloud
are left alone. Pass --delete-missing to make the file the whole truth — cloud
variables it does not list are removed from the instance too, which asks for
confirmation unless --yes is given. --no-input does not waive it: without a way
to ask, the import stops and names --yes.

Without --name/--id, a terminal offers a picker.`,
      args: [{ name: ".env", required: true }],
      flags: {
        target: targetFlag,
        name: nameFlag,
        id: idFlag,
        deleteMissing: bool({
          description: "Remove cloud variables the file does not list.",
        }),
        env: envFlag,
      },
      run: async (input, ctx) => {
        const file = ctx.args[0];
        if (!file) {
          throw new CliError(
            `Usage: pbc env import <.env> --target ${ENV_NOUNS.join("|")} --name <n>`,
            { code: "USAGE" });
        }
        const vars = parseDotenv(await Deno.readTextFile(file));
        const deleteMissing = input.deleteMissing === true;
        if (deleteMissing) {
          const ok = await confirm(
            `Import with --delete-missing will REMOVE cloud variables that ${file} does not list. Continue?`,
            { noInput: ctx.flags.noInput, yes: ctx.flags.yes },
          );
          if (!ok) {
            console.error("Aborted.");
            return 0;
          }
        }
        const { client, targetId, type } = await resolveVarTarget(ctx, input, true);
        const res = await client.ext("/api/env/bulk-set", {
          target_id: targetId,
          type,
          variables: vars,
          prune: deleteMissing,
        });
        if (!res.ok) throw await httpError(res, "Import");
        await recordEnvDigest(
          envStateKey(type, targetId),
          await envDigest(vars, deleteMissing),
          deps.envStatePath?.(),
        );
        const removed = prunedKeysOf(await res.json());
        const imported = Object.keys(vars).length;
        emit(
          ctx.flags.json,
          { imported, removed },
          () =>
            [
              `Imported ${imported} vars.`,
              ...(removed.length > 0
                ? [`Removed ${removed.length}: ${removed.join(", ")}.`]
                : []),
            ].join("\n"),
        );
        return 0;
      },
    }),
  };
}
