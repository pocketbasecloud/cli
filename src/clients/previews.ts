import { httpError } from "../errors.ts";
import type { ICloudClient } from "./cloud.ts";
import type { ResourceKind } from "./types.ts";

export type PreviewLifetime = "preview" | "permanent";

export type PreviewMemberKind = "pocketbase" | "frontend" | "backend";

export type PreviewMember = {
  id: string;
  kind: PreviewMemberKind;
  name: string;
  previewOf: string;
  baseUrl: string;
  status: string;
  statusMessage: string;
  deploys?: { behind: number; ahead: number };
  notice?: string;
};

export type CreatedMember = {
  id: string;
  kind: PreviewMemberKind;
  previewOf: string;
};

export type EnvCopied = { memberId: string; keys: string[] };

export type EnvFailed = { memberId: string; message: string };

export type CopyUpdate = {
  id: string;
  kind: PreviewMemberKind;
  outcome: "updated" | "waiting" | "skipped" | "failed";
  diverged?: boolean;
  message?: string;
};

export type PreviewUpdate = {
  updated: boolean;
  conflicts: string[];
  dataCopied: boolean;
  envCopied: EnvCopied[];
  envFailed: EnvFailed[];
  members: CopyUpdate[];
};

export type PreviewSync = {
  behind: number;
  ahead: { added: string[]; changed: string[]; removed: string[] };
  liveRevision: number;
  baseRevision: number;
};

export type PreviewSource = { id: string; name: string; status: string };

export type PreviewSummary = {
  id: string;
  name: string;
  status: "creating" | "ready" | "failed" | "shipping";
  statusMessage: string;
  lifetime: PreviewLifetime;
  expiresAt: string;
  data: "copy" | "empty";
  crons: "off" | "on";
  created: string;
  conflicts?: string[];
  sync?: PreviewSync | null;
  copiedFrom?: PreviewSource | null;
  kind?: PreviewMemberKind;
  resourceId?: string;
  members: PreviewMember[];
};

export const LIVE = "live";

export type ShipPlan = {
  applied: string[];
  conflicts: string[];
  targetOnly: string[];
  sourceOnly: string[];
};

export type ShipPlanMember = {
  id: string;
  kind: "frontend" | "backend";
  name: string;
  action: "ship" | "skip";
  message?: string;
};

export type PreviewChanges = {
  target: { id: string; name: string };
  plan: ShipPlan;
  members: ShipPlanMember[];
};

export const MEMBER_KIND_OF: Record<ResourceKind, PreviewMemberKind> = {
  pocketbases: "pocketbase",
  frontends: "frontend",
  backends: "backend",
};

export const KIND_WORD: Record<PreviewMemberKind, string> = {
  pocketbase: "PocketBase",
  frontend: "website",
  backend: "service",
};

export async function listPreviews(
  client: ICloudClient,
  resourceId: string,
  kind: PreviewMemberKind = "pocketbase",
): Promise<PreviewSummary[]> {
  const res = await client.ext("/api/previews/list", undefined, {
    method: "GET",
    query: { kind, resourceId },
  });
  if (!res.ok) throw await httpError(res, "Previews");
  const body = await res.json().catch(() => ({})) as {
    data?: { previews?: PreviewSummary[] };
  };
  return body.data?.previews ?? [];
}

export async function previewChanges(
  client: ICloudClient,
  previewId: string,
  to?: string,
): Promise<PreviewChanges> {
  const res = await client.ext("/api/previews/changes", {
    previewId,
    ...(to ? { to } : {}),
  });
  if (!res.ok) throw await httpError(res, "Ship plan");
  const body = await res.json().catch(() => ({})) as {
    data?: Partial<PreviewChanges>;
  };
  const plan = body.data?.plan;
  return {
    target: body.data?.target ?? { id: to ?? LIVE, name: to ?? LIVE },
    plan: {
      applied: plan?.applied ?? [],
      conflicts: plan?.conflicts ?? [],
      targetOnly: plan?.targetOnly ?? [],
      sourceOnly: plan?.sourceOnly ?? [],
    },
    members: body.data?.members ?? [],
  };
}

export function sourceLabel(preview: PreviewSummary): string {
  const source = preview.copiedFrom;
  if (!source) return LIVE;
  return source.status === "deleted"
    ? `${source.name} (discarded)`
    : source.name;
}

export function pocketbaseMember(
  preview: PreviewSummary,
): PreviewMember | undefined {
  return preview.members.find((member) => member.kind === "pocketbase") ??
    preview.members[0];
}

export function previewUrl(preview: PreviewSummary): string {
  return pocketbaseMember(preview)?.baseUrl ?? "";
}

export function isDiverged(member: PreviewMember): boolean {
  return (member.deploys?.behind ?? 0) > 0 && (member.deploys?.ahead ?? 0) > 0;
}

export function isPermanent(preview: PreviewSummary): boolean {
  return preview.lifetime === "permanent";
}
