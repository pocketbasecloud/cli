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
