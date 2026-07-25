export type ResourceKind = "pocketbases" | "frontends" | "backends";

export type Project = {
  id: string;
  name: string;
  user: string;
  organization: string;
  createdBy: string;
};

export type Resource = {
  id: string;
  name: string;
  status: string;
  project: string;
  createdBy: string;
  domain?: string;
  subdomain?: string;
};

export type Org = {
  id: string;
  name: string;
  owner: string;
  role: "owner" | "developer";
};
export type User = { id: string; email: string; plan: string };

/**
 * A compute host. Deploys pick one automatically on every plan except Pro,
 * where `cloud pb deploy --server` names one — so the ids have to be listable.
 */
export type Server = {
  id: string;
  name: string;
  status: string;
  location: string;
  ownership: string;
  cores?: number;
  memory?: number;
  disk?: number;
  availableToFreeUsers?: boolean;
  agentInstalled?: boolean;
};
