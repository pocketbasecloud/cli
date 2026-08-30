import type { ICloudClient } from "../clients/cloud.ts";
import type { Project } from "../clients/types.ts";
import type { Config } from "../config.ts";
import { bindingFileName, envVarName, readLinkFile } from "../config.ts";
import { CliError } from "../errors.ts";
import { canPrompt, select } from "../ui/prompt.ts";
import type { PromptIO } from "../ui/prompt.ts";

export type ResolveCtx = {
  client: ICloudClient;
  config: Config;
  cwd: string;
  flagProject?: string;
  noInput: boolean;
  io?: PromptIO;
  log?: (msg: string) => void;
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
      { code: "USAGE" });
  }
  if (!m) {
    const hints = [
      `check the account: \`pbc whoami\` shows who you're logged in as (switch with \`pbc logout && pbc login\`)`,
      `compare names and ids: \`pbc project ls\``,
    ];
    const envToken = envVarName("TOKEN");
    if (envToken) {
      hints.unshift(
        `${envToken} is set, so the CLI acts as that token's account, not your saved login`,
      );
    }
    throw new CliError(
      `No project found matching "${token}".\n${hints
        .map((h) => `- ${h}.`)
        .join("\n")}`,
      { code: "NOT_FOUND", hint: "pbc project ls" },
    );
  }
  return m;
}

export async function resolveProject(ctx: ResolveCtx): Promise<Project> {
  if (ctx.flagProject) return byToken(ctx.client, ctx.flagProject);

  const link = await readLinkFile(ctx.cwd);
  if (link) {
    const p = await byToken(ctx.client, link.projectId);
    ctx.log?.(
      `Project: ${p.name} (${p.id}) — linked in ${
        await bindingFileName(ctx.cwd)
      }`,
    );
    return p;
  }

  if (ctx.config.currentProject) {
    const p = await byToken(ctx.client, ctx.config.currentProject);
    ctx.log?.(
      `Project: ${p.name} (${p.id}) — set with \`pbc project use\``,
    );
    return p;
  }

  const projects = await ctx.client.listProjects();
  if (projects.length === 0) {
    throw new CliError(
      "No projects yet. Create one with `pbc project create`.",
      { code: "NO_TARGET", hint: "pbc project create <name>" },
    );
  }
  const promptOpts = { noInput: ctx.noInput, io: ctx.io };
  if (!canPrompt(promptOpts)) {
    throw new CliError(
      "No project selected. Pass --project or run `pbc project use`.",
      { code: "NO_TARGET", hint: "pbc project use <name|id>" },
    );
  }
  return select(
    "Select a project:",
    projects,
    (p) => `${p.name} (${p.id})`,
    promptOpts,
  );
}
