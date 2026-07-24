import type { CmdCtx, Handler } from "../router.ts";
import type { CloudAuth, Config } from "../config.ts";
import {
  clearEnvironments,
  readOwnPbJson,
  removeEnvironment,
  upsertEnvironment,
} from "../config.ts";
import { resolveEnvironmentName } from "../resolve/environment.ts";
import { reportRemoval } from "./environments.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError } from "../errors.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import type { PromptIO } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";
import { kindLabel, resolveLinkTarget } from "../resolve/link.ts";

export type CloudCmdDeps = {
  requireAuth: () => Promise<
    { client: ICloudClient; config: Config; auth: CloudAuth }
  >;
  loadConfig: () => Promise<Config>;
  saveConfig: (c: Config) => Promise<void>;
  cwd: () => string;
  /** Prompt transport; unset in production so prompts use real stdin. */
  io?: PromptIO;
};

export function makeProjectCommands(
  deps: CloudCmdDeps,
): Record<string, Handler> {
  const ls: Handler = async (ctx: CmdCtx) => {
    const { client, config } = await deps.requireAuth();
    const orgFilter = ctx.raw.org as string | undefined;
    const projects = await client.listProjects(orgFilter);
    printResult(projects, [
      { header: "ID", get: (p) => p.id },
      { header: "NAME", get: (p) => p.name },
      { header: "ORG", get: (p) => p.organization || "-" },
      {
        header: "CURRENT",
        get: (p) => (p.id === config.currentProject ? "*" : ""),
      },
    ], ctx.flags.json);
    return 0;
  };

  const create: Handler = async (ctx: CmdCtx) => {
    const name = ctx.args[0];
    if (!name) throw new CliError("Usage: pb cloud project create <name>", 2);
    const { client } = await deps.requireAuth();
    const p = await client.createProject(name);
    console.log(
      ctx.flags.json
        ? JSON.stringify(p)
        : `Created project ${p.name} (${p.id}).`,
    );
    return 0;
  };

  const use: Handler = async (ctx: CmdCtx) => {
    const token = ctx.args[0];
    if (!token) throw new CliError("Usage: pb cloud project use <name|id>", 2);
    const { client } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config: await deps.loadConfig(),
      cwd: deps.cwd(),
      flagProject: token,
      noInput: true,
    });
    const config = await deps.loadConfig();
    config.currentProject = p.id;
    await deps.saveConfig(config);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ currentProject: p.id })
        : `Now using ${p.name}.`,
    );
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const token = ctx.args[0];
    if (!token) throw new CliError("Usage: pb cloud project rm <name|id>", 2);
    const { client, config } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: token,
      noInput: true,
    });
    if (
      !await confirm(`Delete project ${p.name}?`, {
        noInput: ctx.flags.noInput,
        yes: ctx.flags.yes,
      })
    ) {
      console.log("Aborted.");
      return 0;
    }
    await client.deleteProject(p.id);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleted ${p.name}.`,
    );
    return 0;
  };

  const link: Handler = async (ctx: CmdCtx) => {
    const { client, config } = await deps.requireAuth();
    const cwd = deps.cwd();
    const p = await resolveProject({
      client,
      config,
      cwd,
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput,
    });
    const { kind, resource } = await resolveLinkTarget({
      client,
      projectId: p.id,
      kindToken: ctx.args[0],
      nameToken: ctx.args[1],
      noInput: ctx.flags.noInput,
      io: deps.io,
    });
    // The file's own environments decide the target, never a parent's: link
    // writes here, so it must read from here.
    const own = await readOwnPbJson(cwd);
    if (own.kind && own.kind !== kind) {
      throw new CliError(
        `pb.json is bound to ${own.kind} — link ${kind} from a different ` +
          `directory.`,
        2,
      );
    }
    const environment = resolveEnvironmentName(own, {
      flag: ctx.raw.env as string | undefined,
    }).name;
    await upsertEnvironment(cwd, {
      projectId: p.id,
      kind,
      environment,
      entry: { id: resource.id, name: resource.name },
    });
    console.log(
      ctx.flags.json
        ? JSON.stringify({
          linked: { kind, id: resource.id, name: resource.name, environment },
        })
        : `Linked ./ to ${kindLabel(kind)} "${resource.name}" ` +
          `(environment: ${environment}).`,
    );
    return 0;
  };

  const unlink: Handler = async (ctx: CmdCtx) => {
    const cwd = deps.cwd();
    const own = await readOwnPbJson(cwd);
    const bound = Object.keys(own.environments ?? {});
    if (bound.length === 0) {
      console.log(
        ctx.flags.json
          ? JSON.stringify({ unlinked: [] })
          : "Nothing linked here.",
      );
      return 0;
    }
    if (ctx.raw.all === true) {
      const removed = await clearEnvironments(cwd);
      console.log(
        ctx.flags.json
          ? JSON.stringify({ unlinked: removed })
          : `Unlinked ./ from ${removed.length} environment(s): ${
            removed.join(", ")
          }.`,
      );
      return 0;
    }
    const environment = resolveEnvironmentName(own, {
      flag: ctx.raw.env as string | undefined,
    }).name;
    const entry = own.environments?.[environment];
    if (!entry) {
      throw new CliError(
        `Unknown environment "${environment}". Configured: ${
          bound.join(", ")
        }.`,
        2,
      );
    }
    const removal = await removeEnvironment(cwd, environment);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ unlinked: [environment] })
        : `Unlinked ./ from ${kindLabel(own.kind!)} "${entry.name}" ` +
          `(environment: ${environment}).`,
    );
    if (!ctx.flags.json) reportRemoval(removal, environment, console.log);
    return 0;
  };

  return {
    "cloud project ls": ls,
    "cloud project create": create,
    "cloud project use": use,
    "cloud project rm": rm,
    "cloud link": link,
    "cloud unlink": unlink,
  };
}
