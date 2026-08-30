import type { Resource, ResourceKind } from "./clients/types.ts";
import type { Column, Field } from "./ui/output.ts";

export type Capability = "domains" | "env" | "logs" | "admin";

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
  columns: Column<Resource>[];
  fields: Field<Resource>[];
};

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
    columns: [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: (r) => r.status },
      { header: "DOMAIN", get: (r) => r.domain ?? r.subdomain ?? "-" },
      { header: "CREATED BY", get: (r) => r.createdBy },
    ],
    fields: [
      { label: "NAME", get: (r) => r.name },
      { label: "ID", get: (r) => r.id },
      { label: "STATUS", get: (r) => r.status },
      { label: "URL", get: (r) => extra(r, "baseUrl") },
      { label: "VERSION", get: (r) => extra(r, "version") },
      { label: "COMPUTE", get: (r) => extra(r, "server") },
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
    env: false,
    logs: false,
    admin: false,
    columns: [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: (r) => r.status },
      { header: "DOMAIN", get: (r) => r.domain ?? "-" },
      { header: "CREATED BY", get: (r) => r.createdBy },
    ],
    fields: [
      { label: "NAME", get: (r) => r.name },
      { label: "ID", get: (r) => r.id },
      { label: "STATUS", get: (r) => r.status },
      { label: "URL", get: (r) => extra(r, "baseUrl") },
      { label: "DOMAIN", get: (r) => r.domain },
      { label: "CUSTOM DOMAIN", get: (r) => r.custom_domain },
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
    columns: [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: (r) => r.status },
      { header: "CREATED BY", get: (r) => r.createdBy },
    ],
    fields: [
      { label: "NAME", get: (r) => r.name },
      { label: "ID", get: (r) => r.id },
      { label: "STATUS", get: (r) => r.status },
      { label: "URL", get: (r) => extra(r, "baseUrl") },
      { label: "DOMAIN", get: (r) => r.domain },
      { label: "CUSTOM DOMAIN", get: (r) => r.custom_domain },
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
