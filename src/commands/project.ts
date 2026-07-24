import type { CmdCtx, Handler } from "../router.ts";
import type { CloudAuth, Config } from "../config.ts";
import { writeLinkFile } from "../config.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError } from "../errors.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";

export type CloudCmdDeps = {
  requireAuth: () => Promise<
    { client: ICloudClient; config: Config; auth: CloudAuth }
  >;
  loadConfig: () => Promise<Config>;
  saveConfig: (c: Config) => Promise<void>;
  cwd: () => string;
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
    const token = ctx.args[0];
    const { client, config, auth } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: token,
      noInput: ctx.flags.noInput,
    });
    await writeLinkFile(deps.cwd(), {
      projectId: p.id,
      backendUrl: auth.backendUrl,
    });
    console.log(
      ctx.flags.json
        ? JSON.stringify({ linked: p.id })
        : `Linked this directory to ${p.name}.`,
    );
    return 0;
  };

  return {
    "cloud project ls": ls,
    "cloud project create": create,
    "cloud project use": use,
    "cloud project rm": rm,
    "cloud link": link,
  };
}
