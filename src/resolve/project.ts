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
  /**
   * Called once, only when the project was resolved implicitly (a linked
   * pbc.json or the globally `use`d project) — an explicit --project needs no
   * confirmation, and an interactive pick is already visible on screen.
   */
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
      2,
    );
  }
  if (!m) {
    // The mismatch is usually cross-account — a linked pbc.json or a `project
    // use` from a previous login, now acted on as someone else — so name that
    // first. PBC_TOKEN is the silent version of the same mistake: it overrides
    // the saved login without saying so.
    const hints = [
      `check the account: \`pbc cloud whoami\` shows who you're logged in as (switch with \`pbc cloud logout && pbc cloud login\`)`,
      `compare names and ids: \`pbc cloud project ls\``,
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
      2,
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
      `Project: ${p.name} (${p.id}) — set with \`pbc cloud project use\``,
    );
    return p;
  }

  const projects = await ctx.client.listProjects();
  if (projects.length === 0) {
    throw new CliError(
      "No projects yet. Create one with `pbc cloud project create`.",
      2,
    );
  }
  // Not just --no-input: a menu on a non-TTY (a pipe, CI) or under --json (its
  // caller folds that into noInput) would hang or corrupt the output, so give
  // the actionable usage error rather than letting `select` throw its generic
  // "input required" one.
  const promptOpts = { noInput: ctx.noInput, io: ctx.io };
  if (!canPrompt(promptOpts)) {
    throw new CliError(
      "No project selected. Pass --project or run `pbc cloud project use`.",
      2,
    );
  }
  return select(
    "Select a project:",
    projects,
    (p) => `${p.name} (${p.id})`,
    promptOpts,
  );
}
