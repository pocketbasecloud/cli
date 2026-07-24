import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource, ResourceKind } from "../clients/types.ts";
import { CliError } from "../errors.ts";

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
