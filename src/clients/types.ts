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
  subStatus?: string;
  statusMessage?: string;
  project: string;
  createdBy: string;
  created?: string;
  updated?: string;
  domain?: string;
  subdomain?: string;
  custom_domain?: string;
  custom_domain_status?: string;
  runtimeFlags?: Record<string, boolean | number | string>;
};

export type Org = {
  id: string;
  name: string;
  owner: string;
  role: "owner" | "developer";
};
export type User = {
  id: string;
  email: string;
  plan: string;
  role?: string;
};

export type DeployContext = {
  ownerPlan: string;
  isOwner: boolean;
  organization: string;
  servers: DeployContextServer[];
  locations?: string[];
  starterLocations?: string[];
  proLocations?: string[];
};

export type DeployContextServer = {
  id: string;
  name: string;
  location: string;
};

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
