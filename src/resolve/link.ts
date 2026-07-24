import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource, ResourceKind } from "../clients/types.ts";
import { CliError } from "../errors.ts";
import { select } from "../ui/prompt.ts";
import type { PromptIO } from "../ui/prompt.ts";

/**
 * The words `pb cloud link` accepts for a resource kind. These mirror the
 * command namespaces (`pb cloud frontend …`) rather than the internal plural
 * `ResourceKind`, and are the single source of truth for what is valid.
 */
const KIND_ALIASES: Record<string, ResourceKind> = {
  pb: "pocketbases",
  pocketbase: "pocketbases",
  frontend: "frontends",
  backend: "backends",
};

const KIND_LABELS: Record<ResourceKind, string> = {
  pocketbases: "pocketbase",
  frontends: "frontend",
  backends: "backend",
};

export const LINK_USAGE =
  "Usage: pb cloud link <pb|frontend|backend> <name|id>";

export function parseKind(token: string): ResourceKind | null {
  return KIND_ALIASES[token.toLowerCase()] ?? null;
}

export function kindLabel(kind: ResourceKind): string {
  return KIND_LABELS[kind];
}

export type ResolveLinkCtx = {
  client: ICloudClient;
  projectId: string;
  /** First positional: a kind word, or undefined for the merged picker. */
  kindToken?: string;
  /** Second positional: the resource name or id. */
  nameToken?: string;
  noInput: boolean;
  io?: PromptIO;
};

export type LinkTarget = { kind: ResourceKind; resource: Resource };

/** Match a name-or-id token within one kind, id first (ids are unique). */
function matchResource(
  resources: Resource[],
  token: string,
  label: string,
): Resource {
  const byId = resources.find((r) => r.id === token);
  if (byId) return byId;
  const byName = resources.filter((r) => r.name === token);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new CliError(
      `Multiple ${label}s named "${token}". Pass the id instead.`,
      2,
    );
  }
  throw new CliError(`No ${label} found matching "${token}".`, 2);
}

/**
 * Resolve which existing cloud resource `pb cloud link` should bind to.
 *
 * With both positionals it is a pure lookup; with a kind only it offers that
 * kind's resources; with neither it offers every resource in the project. A
 * picker is unconditional when interactive (as project selection already is),
 * so `--no-input` is rejected up front with the usage line rather than the
 * generic "input required" message.
 */
export async function resolveLinkTarget(
  ctx: ResolveLinkCtx,
): Promise<LinkTarget> {
  if (ctx.kindToken) {
    const kind = parseKind(ctx.kindToken);
    if (!kind) {
      throw new CliError(
        `Unknown kind "${ctx.kindToken}". Expected pb, frontend, or backend.\n` +
          "To set a default project, use `pb cloud project use`.",
        2,
      );
    }
    const label = kindLabel(kind);
    const resources = await ctx.client.listResources(kind, ctx.projectId);
    if (ctx.nameToken) {
      return { kind, resource: matchResource(resources, ctx.nameToken, label) };
    }
    if (ctx.noInput) throw new CliError(LINK_USAGE, 2);
    if (resources.length === 0) {
      throw new CliError(`No ${label}s in this project.`, 2);
    }
    const resource = await select(
      `Select a ${label}:`,
      resources,
      (r) => `${r.name}  ${r.id}  ${r.status}`,
      { noInput: ctx.noInput, io: ctx.io },
    );
    return { kind, resource };
  }

  if (ctx.noInput) throw new CliError(LINK_USAGE, 2);
  const kinds: ResourceKind[] = ["pocketbases", "frontends", "backends"];
  const lists = await Promise.all(
    kinds.map((k) => ctx.client.listResources(k, ctx.projectId)),
  );
  const all: LinkTarget[] = kinds.flatMap((kind, i) =>
    lists[i].map((resource) => ({ kind, resource }))
  );
  if (all.length === 0) {
    throw new CliError("No resources in this project.", 2);
  }
  return await select(
    "Select a resource:",
    all,
    (t) =>
      `${
        kindLabel(t.kind)
      }  ${t.resource.name}  ${t.resource.id}  ${t.resource.status}`,
    { noInput: ctx.noInput, io: ctx.io },
  );
}
