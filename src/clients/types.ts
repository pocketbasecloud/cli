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
  /**
   * Why a deploy ended where it did. On `status: "error"` this is the only
   * explanation there is — the request that failed belonged to a platform-side
   * hook, so there is no response left to read. See `describeSubStatus`.
   */
  subStatus?: string;
  /**
   * A sentence the platform composed for *this* failure, which `subStatus`
   * cannot be: a sub-status maps to one fixed line per failure kind, so it can
   * say a hook could not be installed but never which one. Preferred over the
   * sub-status sentence whenever it is present.
   */
  statusMessage?: string;
  project: string;
  createdBy: string;
  domain?: string;
  subdomain?: string;
  /**
   * A domain of the user's own, pointed at this resource with
   * `<kind> domain add`. Frontends and backends have one; PocketBase instances
   * have no such field, and simply never carry it.
   */
  custom_domain?: string;
  /** "pending" until the platform has verified the DNS record, then "verified". */
  custom_domain_status?: string;
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
  /** Platform role. Absent on an ordinary account. */
  role?: string;
};

/**
 * The project OWNER's deploy context, as `GET /api/deploy-context` reports it.
 *
 * A deploy is billed to the project owner, so what may be deployed and onto
 * what is the owner's plan and the owner's compute — not the caller's. A
 * developer in someone else's organization cannot read either directly:
 * `servers.listRule` is `createdBy = @request.auth.id`, and `users` is not
 * listable at all. This route is the platform's answer to both.
 */
export type DeployContext = {
  /** Plan of the project owner. Backends require "pro". */
  ownerPlan: string;
  /** True when the caller owns the project rather than developing in it. */
  isOwner: boolean;
  /**
   * Id of the organization this project belongs to, or "" when it is personal.
   * An org project is force-owned by the org owner, so its deploys pick from
   * the organization's compute whoever runs them.
   */
  organization: string;
  /** The owner's running compute, newest first. */
  servers: DeployContextServer[];
};

export type DeployContextServer = {
  id: string;
  name: string;
  location: string;
};

/**
 * A compute host. Deploys pick one automatically on every plan except Pro,
 * where `cloud pb deploy --compute` names one — so the ids have to be listable.
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
