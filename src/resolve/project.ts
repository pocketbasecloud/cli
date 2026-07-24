import type { ICloudClient } from "../clients/cloud.ts";
import type { Project } from "../clients/types.ts";
import type { Config } from "../config.ts";
import { readLinkFile } from "../config.ts";
import { CliError } from "../errors.ts";
import { select } from "../ui/prompt.ts";
import type { PromptIO } from "../ui/prompt.ts";

export type ResolveCtx = {
  client: ICloudClient;
  config: Config;
  cwd: string;
  flagProject?: string;
  noInput: boolean;
  io?: PromptIO;
};

export function matchProject(
  projects: Project[],
  token: string,
): Project | "ambiguous" | null {
  const byId = projects.find((p) => p.id === token);
  if (byId) return byId;
  const byName = projects.filter((p) => p.name === token);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return "ambiguous";
  return null;
}

async function byToken(client: ICloudClient, token: string): Promise<Project> {
  const projects = await client.listProjects();
  const m = matchProject(projects, token);
  if (m === "ambiguous") {
    throw new CliError(
      `Multiple projects named "${token}". Pass the project id instead.`,
      2,
    );
  }
  if (!m) throw new CliError(`No project found matching "${token}".`, 2);
  return m;
}

export async function resolveProject(ctx: ResolveCtx): Promise<Project> {
  if (ctx.flagProject) return byToken(ctx.client, ctx.flagProject);

  const link = await readLinkFile(ctx.cwd);
  if (link) return byToken(ctx.client, link.projectId);

  if (ctx.config.currentProject) {
    return byToken(ctx.client, ctx.config.currentProject);
  }

  const projects = await ctx.client.listProjects();
  if (projects.length === 0) {
    throw new CliError(
      "No projects yet. Create one with `pb cloud project create`.",
      2,
    );
  }
  if (ctx.noInput) {
    throw new CliError(
      "No project selected. Pass --project, run `pb cloud link`, or `pb cloud project use`.",
      2,
    );
  }
  return select("Select a project:", projects, (p) => `${p.name} (${p.id})`, {
    noInput: ctx.noInput,
    io: ctx.io,
  });
}
