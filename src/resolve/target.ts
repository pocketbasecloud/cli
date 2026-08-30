import type { ICloudClient } from "../clients/cloud.ts";
import type { Project, Resource } from "../clients/types.ts";
import { readLinkFile, type Config, type LinkFile } from "../config.ts";
import { CliError } from "../errors.ts";
import type { KindSpec } from "../kinds.ts";
import { nearestCommand } from "../parse.ts";
import { chooseFromMenu } from "../ui/menu.ts";
import { canPrompt } from "../ui/prompt.ts";
import type { PromptIO } from "../ui/prompt.ts";
import {
  assertConfigured,
  resolveEnvironmentName,
} from "./environment.ts";
import { matchProject } from "./project.ts";

export type ResourceTargetCtx = {
  client: ICloudClient;
  spec: KindSpec;
  cwd: string;
  name?: string;
  id?: string;
  envFlag?: string;
  projectFilter?: string;
  config?: Config;
  explicit: boolean;
  noInput: boolean;
  io?: PromptIO;
  log?: (msg: string) => void;
};

export type ResolvedResource = {
  resource: Resource;
  environment: string;
};

export function parseQualifiedName(
  token: string,
): { project?: string; name: string } {
  const slash = token.indexOf("/");
  if (slash === -1) return { name: token };
  return { project: token.slice(0, slash), name: token.slice(slash + 1) };
}

function lsHint(spec: KindSpec): string {
  return `pbc ${spec.noun} ls`;
}

function noTargetError(spec: KindSpec): CliError {
  const noun = spec.noun;
  return new CliError(
    `No ${spec.label} named. Pass --name or --id to name one.\n` +
      `  name one:   pbc ${noun} <verb> <name>\n` +
      `  list them:  pbc ${noun} ls`,
    { code: "NO_TARGET", hint: lsHint(spec) },
  );
}

function noResourcesInProjectError(
  spec: KindSpec,
  projectName: string,
): CliError {
  return new CliError(
    `No ${spec.label}s in project "${projectName}".\n` +
      `  list them:  pbc ${spec.noun} ls`,
    { code: "NOT_FOUND", hint: lsHint(spec) },
  );
}

function noResourcesAnywhereError(spec: KindSpec): CliError {
  return new CliError(
    `No ${spec.label}s on this account yet.\n` +
      `  create one:  pbc ${spec.noun} deploy --new <name>\n` +
      `  list them:   pbc ${spec.noun} ls`,
    { code: "NOT_FOUND", hint: lsHint(spec) },
  );
}

async function projectsById(
  client: ICloudClient,
): Promise<Map<string, Project>> {
  const projects = await client.listProjects();
  return new Map(projects.map((p) => [p.id, p]));
}

async function resolveProjectScope(
  ctx: ResourceTargetCtx,
  link: LinkFile | null,
): Promise<{ id: string; name: string } | undefined> {
  const token = ctx.projectFilter ?? link?.projectId ?? ctx.config?.currentProject;
  if (!token) return undefined;
  const projects = await ctx.client.listProjects();
  const m = matchProject(projects, token);
  if (m === "ambiguous") {
    throw new CliError(
      `More than one project is named "${token}". Pass its id.`,
      { code: "USAGE" },
    );
  }
  if (!m) {
    throw new CliError(
      `No project matching "${token}".`,
      { code: "NOT_FOUND", hint: "pbc project ls" },
    );
  }
  return { id: m.id, name: m.name };
}

function qualify(r: Resource, projects: Map<string, Project>): string {
  return `${projects.get(r.project)?.name ?? r.project}/${r.name}`;
}

async function matchByName(
  ctx: ResourceTargetCtx,
  token: string,
  candidates: Resource[],
): Promise<Resource> {
  const { project: projToken, name } = parseQualifiedName(token);
  let pool = candidates;
  const projects = await projectsById(ctx.client);
  if (projToken) {
    const p = matchProject([...projects.values()], projToken);
    if (p === "ambiguous") {
      throw new CliError(
        `More than one project is named "${projToken}". Pass its id.`,
        { code: "USAGE" },
      );
    }
    if (!p) {
      throw new CliError(
        `No project matching "${projToken}".`,
        { code: "NOT_FOUND", hint: "pbc project ls" },
      );
    }
    pool = pool.filter((r) => r.project === p.id);
  }

  const matches = pool.filter((r) => r.name === name || r.id === name);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new CliError(
      `More than one ${ctx.spec.label} is named "${name}":\n` +
        matches.map((r) => `  ${qualify(r, projects)}`).join("\n") +
        `\nName it as project/name.`,
      { code: "USAGE", hint: lsHint(ctx.spec) },
    );
  }

  const near = nearestCommand(name, pool.map((r) => r.name));
  throw new CliError(
    `No ${ctx.spec.label} named "${name}".` +
      (near ? ` Did you mean "${near}"?` : ""),
    { code: "NOT_FOUND", hint: lsHint(ctx.spec) },
  );
}

async function pickFromMenu(
  ctx: ResourceTargetCtx,
  candidates: Resource[],
): Promise<Resource> {
  const projects = await projectsById(ctx.client);
  const choice = await chooseFromMenu({
    items: candidates,
    label: ctx.spec.label,
    verb: "Select",
    allowCreate: false,
    key: (r) => ({
      name: r.name,
      id: r.id,
      status: r.status,
      project: projects.get(r.project)?.name,
      updated: r.updated,
    }),
    opts: { noInput: ctx.noInput, io: ctx.io },
  });
  if (choice.create) {
    throw new CliError(`No ${ctx.spec.label} selected.`, { code: "NO_TARGET" });
  }
  return choice.item;
}

export async function resolveResourceTarget(
  ctx: ResourceTargetCtx,
): Promise<ResolvedResource> {
  const link = await readLinkFile(ctx.cwd);
  const envChoice = resolveEnvironmentName(link, { flag: ctx.envFlag });
  assertConfigured(envChoice, link);
  const environment = envChoice.name;

  const scope = await resolveProjectScope(ctx, link);
  const candidates = await ctx.client.listResources(
    ctx.spec.kind,
    scope ? { project: scope.id } : undefined,
  );

  if (ctx.id) {
    const found = candidates.find((r) => r.id === ctx.id);
    if (!found) {
      throw new CliError(
        `No ${ctx.spec.label} with id "${ctx.id}".`,
        { code: "NOT_FOUND", hint: lsHint(ctx.spec) },
      );
    }
    return { resource: found, environment };
  }

  if (ctx.name) {
    return {
      resource: await matchByName(ctx, ctx.name, candidates),
      environment,
    };
  }

  const bound = link && link.kind === ctx.spec.kind
    ? link.environments?.[environment]
    : undefined;
  if (bound?.id) {
    const found = candidates.find((r) => r.id === bound.id);
    if (found) {
      ctx.log?.(
        `${ctx.spec.label}: ${found.name} (${found.id}) — linked in pbc.json`,
      );
      return { resource: found, environment };
    }
    throw new CliError(
      `The ${ctx.spec.label} bound to environment "${environment}" no longer ` +
        `exists. Recreate it with \`pbc ${ctx.spec.noun} deploy --new <name>\`.`,
      { code: "NOT_FOUND", hint: `pbc ${ctx.spec.noun} ls` },
    );
  }

  if (candidates.length === 0) {
    throw scope
      ? noResourcesInProjectError(ctx.spec, scope.name)
      : noResourcesAnywhereError(ctx.spec);
  }

  if (!ctx.explicit && candidates.length === 1) {
    ctx.log?.(
      `${ctx.spec.label}: ${candidates[0].name} (${candidates[0].id})`,
    );
    return { resource: candidates[0], environment };
  }

  if (!canPrompt({ noInput: ctx.noInput, io: ctx.io })) {
    throw noTargetError(ctx.spec);
  }

  return { resource: await pickFromMenu(ctx, candidates), environment };
}
