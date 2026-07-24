import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource, ResourceKind } from "../clients/types.ts";
import { CliError } from "../errors.ts";
import { type PromptIO, select } from "../ui/prompt.ts";

export function findExisting(
  resources: Resource[],
  opts: { id?: string; name?: string },
): Resource | "ambiguous" | null {
  if (opts.id) return resources.find((r) => r.id === opts.id) ?? null;
  if (opts.name) {
    const matches = resources.filter((r) => r.name === opts.name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return "ambiguous";
  }
  return null;
}

/**
 * Resolve a single existing resource by name/id. When the token is missing or
 * ambiguous and `interactive` is set, present a selection menu of the existing
 * resources instead of erroring — the "custom" interactive path for the
 * name-or-id OR-lookups that `info`/`rm`/`logs`/`env` use.
 */
export async function resolveExisting(
  resources: Resource[],
  token: { id?: string; name?: string },
  opts: {
    label: string;
    interactive: boolean;
    noInput: boolean;
    errorMessage?: string;
    io?: PromptIO;
  },
): Promise<Resource> {
  const found = findExisting(resources, token);
  if (found && found !== "ambiguous") return found;
  if (opts.interactive) {
    if (resources.length === 0) {
      throw new CliError(`No ${opts.label} found.`, 2);
    }
    return await select(
      `Select a ${opts.label}:`,
      resources,
      (r) => `${r.name}  ${r.id}  ${r.status}`,
      { noInput: opts.noInput, io: opts.io },
    );
  }
  throw new CliError(
    opts.errorMessage ?? "Specify a unique --name or --id.",
    2,
  );
}

export async function deployResource(
  client: ICloudClient,
  kind: ResourceKind,
  projectId: string,
  opts: { id?: string; name?: string; data: Record<string, unknown> },
): Promise<{ resource: Resource; created: boolean }> {
  const existing = findExisting(
    await client.listResources(kind, projectId),
    opts,
  );
  if (existing === "ambiguous") {
    throw new CliError(`Multiple ${kind} named "${opts.name}". Pass --id.`, 2);
  }
  if (existing) {
    return {
      resource: await client.updateResource(kind, existing.id, opts.data),
      created: false,
    };
  }
  return {
    resource: await client.createResource(kind, opts.data),
    created: true,
  };
}

export async function pollStatus(
  client: ICloudClient,
  kind: ResourceKind,
  id: string,
  opts: {
    terminal: string[];
    timeoutMs: number;
    intervalMs: number;
    onTick?: (s: string) => void;
  },
): Promise<Resource> {
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    const r = await client.getResource(kind, id);
    opts.onTick?.(r.status);
    if (opts.terminal.includes(r.status)) return r;
    if (Date.now() > deadline) {
      throw new CliError(
        `Timed out waiting for ${kind} ${id} (last: ${r.status}).`,
        5,
      );
    }
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  }
}
