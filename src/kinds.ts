import type { Resource, ResourceKind } from "./clients/types.ts";
import type { Column, Field } from "./ui/output.ts";
import { resourceLocationLabel } from "./ui/compute.ts";

export type Capability =
  | "domains"
  | "env"
  | "logs"
  | "admin"
  | "rollback"
  | "access";

export type KindSpec = {
  kind: ResourceKind;
  noun: string;
  aliases: readonly string[];
  label: string;
  display: string;
  idNoun: string;
  idField: string;
  apiType?: string;
  deploy: string;
  domains: boolean;
  env: boolean;
  logs: boolean;
  admin: boolean;
  rollback: boolean;
  access: boolean;
  columns: Column<Resource>[];
  fields: Field<Resource>[];
};

export const MOVING_SUB_STATUS = "moving";
export const MOVE_FAILED_SUB_STATUS = "moveFailed";

export function isMoving(r: Pick<Resource, "status" | "subStatus">): boolean {
  return r.status === "deploying" && r.subStatus === MOVING_SUB_STATUS;
}

function displayStatus(r: Resource): string {
  return isMoving(r) ? "moving" : r.status;
}

function extra(r: Resource, key: string): string | undefined {
  return (r as unknown as Record<string, string | undefined>)[key];
}

export const KINDS: Record<ResourceKind, KindSpec> = {
  pocketbases: {
    kind: "pocketbases",
    noun: "pocketbase",
    aliases: ["pb", "pocketbase"],
    label: "PocketBase",
    display: "PocketBase instance",
    idNoun: "instance",
    idField: "pocketbase_id",
    apiType: "pocketbase",
    deploy: "pbdirs",
    domains: true,
    env: true,
    logs: true,
    admin: true,
    rollback: true,
    access: false,
    columns: [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: displayStatus },
      { header: "DOMAIN", get: (r) => r.domain ?? r.subdomain ?? "-" },
      { header: "LOCATION", get: (r) => resourceLocationLabel(r) },
      { header: "CREATED BY", get: (r) => r.createdBy },
    ],
    fields: [
      { label: "NAME", get: (r) => r.name },
      { label: "ID", get: (r) => r.id },
      { label: "STATUS", get: displayStatus },
      { label: "URL", get: (r) => extra(r, "baseUrl") },
      { label: "VERSION", get: (r) => extra(r, "version") },
      { label: "LOCATION", get: (r) => resourceLocationLabel(r) },
      {
        label: "OLD ADDRESS",
        get: (r) =>
          r.previousDomain
            ? `${r.previousDomain} (forwards here until the previous copy is deleted)`
            : undefined,
      },
      { label: "MOVED", get: (r) => r.movedAt || undefined },
      {
        label: "LAST MOVE",
        get: (r) =>
          r.subStatus === MOVE_FAILED_SUB_STATUS
            ? r.statusMessage || "Did not complete."
            : undefined,
      },
      { label: "PROJECT", get: (r) => r.project },
      { label: "ADMIN", get: (r) => extra(r, "adminUsername") },
      { label: "PASSWORD", get: (r) => extra(r, "adminPassword") },
      { label: "CREATED", get: (r) => extra(r, "created") },
    ],
  },
  frontends: {
    kind: "frontends",
    noun: "frontend",
    aliases: ["frontend"],
    label: "frontend",
    display: "frontend",
    idNoun: "site",
    idField: "frontend_id",
    deploy: "static | source",
    domains: true,
    env: true,
    logs: false,
    admin: false,
    rollback: true,
    access: true,
    columns: [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: (r) => r.status },
      { header: "DOMAIN", get: (r) => r.domain ?? "-" },
      { header: "LOCATION", get: (r) => resourceLocationLabel(r) },
      { header: "CREATED BY", get: (r) => r.createdBy },
    ],
    fields: [
      { label: "NAME", get: (r) => r.name },
      { label: "ID", get: (r) => r.id },
      { label: "STATUS", get: (r) => r.status },
      { label: "URL", get: (r) => extra(r, "baseUrl") },
      { label: "DOMAIN", get: (r) => r.domain },
      { label: "CUSTOM DOMAIN", get: (r) => r.custom_domain },
      { label: "LOCATION", get: (r) => resourceLocationLabel(r) },
      { label: "PROJECT", get: (r) => r.project },
      { label: "CREATED", get: (r) => extra(r, "created") },
    ],
  },
  backends: {
    kind: "backends",
    noun: "backend",
    aliases: ["backend"],
    label: "backend",
    display: "backend",
    idNoun: "backend",
    idField: "backend_id",
    apiType: "backend",
    deploy: "standalone",
    domains: true,
    env: true,
    logs: true,
    admin: false,
    rollback: true,
    access: true,
    columns: [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: (r) => r.status },
      { header: "LOCATION", get: (r) => resourceLocationLabel(r) },
      { header: "CREATED BY", get: (r) => r.createdBy },
    ],
    fields: [
      { label: "NAME", get: (r) => r.name },
      { label: "ID", get: (r) => r.id },
      { label: "STATUS", get: (r) => r.status },
      { label: "URL", get: (r) => extra(r, "baseUrl") },
      { label: "DOMAIN", get: (r) => r.domain },
      { label: "CUSTOM DOMAIN", get: (r) => r.custom_domain },
      { label: "LOCATION", get: (r) => resourceLocationLabel(r) },
      { label: "PROJECT", get: (r) => r.project },
      { label: "CREATED", get: (r) => extra(r, "created") },
    ],
  },
};

export const ALL_KINDS: KindSpec[] = [
  KINDS.pocketbases,
  KINDS.frontends,
  KINDS.backends,
];

export function kindsWith(cap: Capability): KindSpec[] {
  return ALL_KINDS.filter((k) => k[cap]);
}

export function kindByAlias(token: string): KindSpec | null {
  const t = token.toLowerCase();
  return ALL_KINDS.find((k) => k.aliases.includes(t)) ?? null;
}

export function kindPlural(spec: KindSpec): string {
  return `${spec.display}s`;
}
