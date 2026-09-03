import PocketBase, { ClientResponseError } from "pocketbase";
import { VERSION } from "../version.ts";
import type { CloudAuth } from "../config.ts";
import { CliError, codeFromStatus, fieldErrors } from "../errors.ts";
import { MAX_ARCHIVE_MB } from "../limits.ts";
import type {
  DeployContext,
  Org,
  Project,
  Resource,
  ResourceKind,
  Server,
  User,
} from "./types.ts";

export interface ICloudClient {
  whoami(): Promise<User>;
  listProjects(orgId?: string): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  listResources(
    kind: ResourceKind,
    opts?: { project?: string },
  ): Promise<Resource[]>;
  createResource(
    kind: ResourceKind,
    data: Record<string, unknown>,
  ): Promise<Resource>;
  updateResource(
    kind: ResourceKind,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Resource>;
  getResource(kind: ResourceKind, id: string): Promise<Resource>;
  listServers(): Promise<Server[]>;
  deployContext(projectId?: string): Promise<DeployContext>;
  listOrgs(): Promise<Org[]>;
  createOrg(name: string): Promise<Org>;
  deleteOrg(id: string): Promise<void>;
  listMembers(orgId: string): Promise<{ email: string; role: string }[]>;
  addMember(orgId: string, email: string): Promise<void>;
  removeMember(orgId: string, email: string): Promise<void>;
  shareProject(projectId: string, orgId: string | null): Promise<void>;
  fileToken(): Promise<string>;
  ext(path: string, body?: unknown, opts?: ApiOpts): Promise<Response>;
  pbApi(path: string, body?: unknown, opts?: ApiOpts): Promise<Response>;
}

export type ApiOpts = {
  method?: "GET" | "POST";
  query?: Record<string, string>;
};

function bodylessMessage(status: number): string {
  if (status === 0) {
    return "Could not reach PocketBase Cloud. Check your connection (and `pbc whoami` for the configured URL), then try again.";
  }
  if (status === 502 || status === 503) {
    return `Platform error (${status}): the platform is unreachable right now. This is usually brief — try again in a moment.`;
  }
  if (status === 504 || status === 408) {
    return `Platform error (${status}): the platform took too long to respond. Try again in a moment.`;
  }
  if (status >= 500) {
    return `Platform error (${status}): the platform had a problem handling that request. Try again in a moment.`;
  }
  return `Platform error (${status}): the request was rejected and the response carried no detail.`;
}

export function mapPbError(e: unknown): CliError {
  if (e instanceof ClientResponseError) {
    if (e.status === 403) {
      const reason = e.response?.message;
      return new CliError(
        reason && reason.length > 0
          ? reason
          : "Permission denied. This action may require organization owner rights.",
        { code: "FORBIDDEN" },
      );
    }
    if (e.status === 401) {
      return new CliError(
        "Not authenticated. Run `pbc login`.",
        { code: "NOT_AUTHENTICATED" },
      );
    }
    if (e.status === 413) {
      return new CliError(
        `The upload is over the ${MAX_ARCHIVE_MB} MB limit. Trim the build output (or exclude node_modules and source maps) and deploy again.`,
        { code: "INVALID_VALUE" },
      );
    }
    const code = codeFromStatus(e.status);
    if (!e.response?.message) {
      return new CliError(bodylessMessage(e.status), code ? { code } : {});
    }
    const msg = e.response.message;
    const { detail, fields } = fieldErrors(e.response?.data);
    return new CliError(
      `Platform error (${e.status}): ${msg}${detail ? ` — ${detail}` : ""}`,
      { ...(code ? { code } : {}), fields },
    );
  }
  return new CliError(String(e));
}

const NOT_DELETED = 'status != "deleted"';

function generateTraceId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export class PocketBaseCloudClient implements ICloudClient {
  private pb: PocketBase;
  private cachedUserId?: string;
  constructor(private auth: CloudAuth) {
    this.pb = new PocketBase(auth.backendUrl);
    this.pb.authStore.save(auth.userToken, null);

    this.pb.beforeSend = (url, options) => {
      options.headers = Object.assign(options.headers || {}, {
        "X-Trace-Id": generateTraceId(),
        "X-Client-Type": "cli",
        "User-Agent": `pb-cloud-cli/${VERSION}`,
      });
      return { url, options };
    };
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw mapPbError(e);
    }
  }

  private async ownerId(): Promise<string> {
    if (this.auth.userId) return this.auth.userId;
    this.cachedUserId ??= (await this.whoami()).id;
    return this.cachedUserId;
  }

  whoami(): Promise<User> {
    return this.guard(async () => {
      const rec = await this.pb.collection("users").authRefresh();
      const u = rec.record as unknown as {
        id: string;
        email: string;
        plan: string;
        role?: string;
      };
      return {
        id: u.id,
        email: u.email,
        plan: u.plan ?? "free",
        role: u.role || undefined,
      };
    });
  }

  listProjects(orgId?: string): Promise<Project[]> {
    return this.guard(async () => {
      const filter = [
        NOT_DELETED,
        orgId ? `organization = "${orgId}"` : "",
      ].filter(Boolean).join(" && ");
      const recs = await this.pb.collection("projects").getFullList({ filter });
      return recs as unknown as Project[];
    });
  }

  createProject(name: string): Promise<Project> {
    return this.guard(async () =>
      await this.pb.collection("projects").create({
        name,
        user: await this.ownerId(),
      }) as unknown as Project
    );
  }

  deleteProject(id: string): Promise<void> {
    return this.guard(async () => {
      const live: string[] = [];
      for (const kind of ["pocketbases", "backends", "frontends"] as const) {
        const n = (await this.listResources(kind, { project: id })).length;
        if (n > 0) live.push(`${n} ${kind}`);
      }
      if (live.length > 0) {
        throw new CliError(
          `Project still has ${live.join(", ")}. Delete them first.`,
          { code: "USAGE" });
      }
      await this.pb.collection("projects").update(id, { status: "deleted" });
    });
  }

  listResources(
    kind: ResourceKind,
    opts: { project?: string } = {},
  ): Promise<Resource[]> {
    const filter = [
      opts.project ? `project = "${opts.project}"` : "",
      NOT_DELETED,
    ].filter(Boolean).join(" && ");
    return this.guard(async () =>
      await this.pb.collection(kind).getFullList({
        filter,
        sort: "-updated",
      }) as unknown as Resource[]
    );
  }

  createResource(
    kind: ResourceKind,
    data: Record<string, unknown>,
  ): Promise<Resource> {
    return this.guard(async () =>
      await this.pb.collection(kind).create(data) as unknown as Resource
    );
  }

  updateResource(
    kind: ResourceKind,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Resource> {
    return this.guard(async () =>
      await this.pb.collection(kind).update(id, data) as unknown as Resource
    );
  }

  getResource(kind: ResourceKind, id: string): Promise<Resource> {
    return this.guard(async () =>
      await this.pb.collection(kind).getOne(id) as unknown as Resource
    );
  }

  listServers(): Promise<Server[]> {
    return this.guard(async () => {
      const ownerId = await this.ownerId();
      const recs = await this.pb.collection("servers").getFullList({
        filter: `${NOT_DELETED} && createdBy = "${ownerId}"`,
        sort: "created",
      });
      return recs as unknown as Server[];
    });
  }

  deployContext(projectId?: string): Promise<DeployContext> {
    return this.guard(async () => {
      const res = await this.pbApi("/api/deploy-context", undefined, {
        method: "GET",
        query: projectId ? { projectId } : undefined,
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new CliError(
          `Could not read this project's compute (deploy-context: ` +
            `${res.status}). Pass --compute <id> to name it.`);
      }
      return await res.json() as DeployContext;
    });
  }

  listOrgs(): Promise<Org[]> {
    return this.guard(async () => {
      const recs = await this.pb.collection("organizations").getFullList();
      return recs.map((r) => ({
        id: r.id,
        name: r.name as string,
        owner: r.owner as string,
        role: (r.owner === this.auth.userId ? "owner" : "developer") as
          | "owner"
          | "developer",
      }));
    });
  }

  createOrg(name: string): Promise<Org> {
    return this.guard(async () => {
      const r = await this.pb.collection("organizations").create({ name });
      return {
        id: r.id,
        name: r.name as string,
        owner: r.owner as string,
        role: "owner",
      };
    });
  }

  deleteOrg(id: string): Promise<void> {
    return this.guard(async () => {
      await this.pb.collection("organizations").delete(id);
    });
  }

  listMembers(orgId: string): Promise<{ email: string; role: string }[]> {
    return this.guard(async () => {
      const recs = await this.pb.collection("org_members").getFullList({
        filter: `organization = "${orgId}"`,
      });
      return recs.map((r) => ({
        email: r.userEmail as string,
        role: r.role as string,
      }));
    });
  }

  addMember(orgId: string, email: string): Promise<void> {
    return this.guard(async () => {
      await this.pb.collection("org_members").create({
        organization: orgId,
        email,
      });
    });
  }

  removeMember(orgId: string, email: string): Promise<void> {
    return this.guard(async () => {
      const rec = await this.pb.collection("org_members").getFirstListItem(
        `organization = "${orgId}" && userEmail = "${email}"`,
      );
      await this.pb.collection("org_members").delete(rec.id);
    });
  }

  shareProject(projectId: string, orgId: string | null): Promise<void> {
    return this.guard(async () => {
      await this.pb.collection("projects").update(projectId, {
        organization: orgId ?? "",
      });
    });
  }

  fileToken(): Promise<string> {
    return this.guard(() => this.pb.files.getToken());
  }

  ext(path: string, body?: unknown, opts: ApiOpts = {}): Promise<Response> {
    return this.send(this.auth.extUrl, path, body, opts);
  }

  pbApi(path: string, body?: unknown, opts: ApiOpts = {}): Promise<Response> {
    return this.send(this.auth.backendUrl, path, body, opts);
  }

  private send(
    base: string,
    path: string,
    body: unknown,
    opts: ApiOpts,
  ): Promise<Response> {
    const method = opts.method ?? "POST";
    const query = opts.query
      ? `?${new URLSearchParams(opts.query).toString()}`
      : "";
    return fetch(`${base}${path}${query}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.auth.userToken}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  }
}
