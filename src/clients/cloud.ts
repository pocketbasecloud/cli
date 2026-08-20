import PocketBase, { ClientResponseError } from "pocketbase";
import { VERSION } from "../version.ts";
import type { CloudAuth } from "../config.ts";
import { CliError, fieldErrors } from "../errors.ts";
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
  /**
   * Marks the project deleted. Never a hard delete: the collection's
   * deleteRule is null, and the platform's teardown runs off the status
   * change. Rejects while the project still has live resources, which the
   * teardown does not cascade to.
   */
  deleteProject(id: string): Promise<void>;
  listResources(kind: ResourceKind, projectId: string): Promise<Resource[]>;
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
  /** Servers visible to this account: platform pool plus any dedicated compute. */
  listServers(): Promise<Server[]>;
  /**
   * The project owner's plan and compute. The only way to learn either for a
   * project owned by someone else's organization, since both collections are
   * unreadable to a developer.
   */
  deployContext(projectId?: string): Promise<DeployContext>;
  listOrgs(): Promise<Org[]>;
  createOrg(name: string): Promise<Org>;
  deleteOrg(id: string): Promise<void>;
  listMembers(orgId: string): Promise<{ email: string; role: string }[]>;
  addMember(orgId: string, email: string): Promise<void>;
  removeMember(orgId: string, email: string): Promise<void>;
  shareProject(projectId: string, orgId: string | null): Promise<void>;
  /** Short-lived token for downloading a protected file from PocketBase. */
  fileToken(): Promise<string>;
  /** Call a backend-extension route directly. */
  ext(path: string, body?: unknown, opts?: ApiOpts): Promise<Response>;
  /**
   * Call a custom route on PocketBase. Used for the routes backend-extension
   * guards with the service API key: PocketBase holds that key and forwards,
   * which is the only way a user token can reach them — the CLI must never
   * carry the service key itself.
   */
  pbApi(path: string, body?: unknown, opts?: ApiOpts): Promise<Response>;
}

export type ApiOpts = {
  method?: "GET" | "POST";
  query?: Record<string, string>;
};

/**
 * What to say about a failure whose response carried no message — the status
 * is all there is. A 5xx says "try again" and a 4xx does not, because that is
 * the one distinction the caller can act on: a 5xx is the platform's and may
 * pass, a 4xx is the request and will not.
 */
function bodylessMessage(status: number): string {
  // The SDK uses 0 for a request that never got a response at all.
  if (status === 0) {
    return "Could not reach PocketBase Cloud. Check your connection (and `pb cloud whoami` for the configured URL), then try again.";
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
      // The platform's own 403s name the actual fix ("No available PocketBase
      // slots — buy more from the Plan page.", "Backend deployments require a
      // Pro plan…"). Those are far better than anything we can guess, so they
      // win; the org-rights hint is only for a 403 that arrived with no
      // message at all.
      const reason = e.response?.message;
      return new CliError(
        reason && reason.length > 0
          ? reason
          : "Permission denied. This action may require organization owner rights.",
        3,
      );
    }
    if (e.status === 401) {
      return new CliError("Not authenticated. Run `pb cloud login`.", 4);
    }
    if (e.status === 413) {
      // A proxy in front of the platform rejects an oversized body before
      // PocketBase sees it, answering with an HTML error page the SDK cannot
      // parse — so `message` is a contentless "Something went wrong…" and the
      // status is the only thing that identifies it. `assertArchiveWithinLimit`
      // catches this ahead of the upload, but it measures the archive while a
      // proxy measures the whole multipart body, so one right at the limit
      // still gets here — as does any host still on an older Caddyfile.
      return new CliError(
        `The upload is over the ${MAX_ARCHIVE_MB} MB limit. Trim the build output (or exclude node_modules and source maps) and deploy again.`,
        2,
      );
    }
    // No body: a proxy's HTML error page, or a request that never got a
    // response (status 0). The SDK invents "Something went wrong." for both,
    // and repeating that back names neither a cause nor a fix — the status is
    // the whole content of the failure, so say what it means instead.
    if (!e.response?.message) {
      return new CliError(bodylessMessage(e.status), 1);
    }
    const msg = e.response.message;
    // "Failed to create record." on its own says nothing; the reason is always
    // in `data`, one entry per rejected field.
    const { detail, fields } = fieldErrors(e.response?.data);
    return new CliError(
      `Platform error (${e.status}): ${msg}${detail ? ` — ${detail}` : ""}`,
      1,
      fields,
    );
  }
  return new CliError(String(e), 1);
}

/** Every collection here tombstones instead of hard-deleting. */
const NOT_DELETED = 'status != "deleted"';

function generateTraceId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for environments without crypto
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export class PocketBaseCloudClient implements ICloudClient {
  private pb: PocketBase;
  private cachedUserId?: string;
  constructor(private auth: CloudAuth) {
    this.pb = new PocketBase(auth.backendUrl);
    this.pb.authStore.save(auth.userToken, null);

    // Inject trace headers into every PocketBase SDK call for cross-service correlation.
    this.pb.beforeSend = (url, options) => {
      options.headers = Object.assign(options.headers || {}, {
        "X-Trace-Id": generateTraceId(),
        "X-Client-Type": "cli",
        // Named explicitly so the platform's request metrics can tell CLI
        // traffic from browser traffic. PocketBase's own request log records a
        // User-Agent but no X-Client-Type, and that log is where the
        // portal->backend and cli->backend hops are measured — without this
        // the two are indistinguishable and CLI usage vanishes into the
        // portal's numbers.
        "User-Agent": `pb-cloud-cli/${VERSION}`,
      });
      return { url, options };
    };
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      // A CliError raised inside is already the message we want the user to
      // see; only platform failures need mapping.
      if (e instanceof CliError) throw e;
      throw mapPbError(e);
    }
  }

  /**
   * The record owner to send. Token-based auth (PB_TOKEN) carries no
   * id, so ask the platform; the answer is cached for the process.
   */
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
        // `user` is not required by the schema and no hook fills it in for a
        // personal project, but every list/view/update rule keys off it — a
        // project created without one is invisible to its own creator.
        user: await this.ownerId(),
      }) as unknown as Project
    );
  }

  deleteProject(id: string): Promise<void> {
    return this.guard(async () => {
      // Teardown decrements the slot counter; it does not cascade to the
      // project's resources, so leaving them would strand running containers.
      const live: string[] = [];
      for (const kind of ["pocketbases", "backends", "frontends"] as const) {
        const n = (await this.listResources(kind, id)).length;
        if (n > 0) live.push(`${n} ${kind}`);
      }
      if (live.length > 0) {
        throw new CliError(
          `Project still has ${live.join(", ")}. Delete them first.`,
          2,
        );
      }
      await this.pb.collection("projects").update(id, { status: "deleted" });
    });
  }

  listResources(kind: ResourceKind, projectId: string): Promise<Resource[]> {
    return this.guard(async () =>
      await this.pb.collection(kind).getFullList({
        filter: `project = "${projectId}" && ${NOT_DELETED}`,
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
      const recs = await this.pb.collection("servers").getFullList({
        // The account's own compute only. The collection's list rule also
        // exposes every platform host flagged `availableToFreeUsers`, which
        // belongs to nobody here: the shared pool is auto-selected by capacity,
        // so listing it would only offer ids `--compute` should never be given.
        filter: `${NOT_DELETED} && createdBy = @request.auth.id`,
        // Oldest-first, so "Compute N" numbers the same machine as the portal's
        // picker (which reverses deploy-context's newest-first answer).
        sort: "created",
      });
      return recs as unknown as Server[];
    });
  }

  deployContext(projectId?: string): Promise<DeployContext> {
    return this.guard(async () => {
      // No projectId answers about the caller — the project they are about to
      // create and will own — which is the pre-project case for `--location`.
      const res = await this.pbApi("/api/deploy-context", undefined, {
        method: "GET",
        query: projectId ? { projectId } : undefined,
      });
      if (!res.ok) {
        await res.body?.cancel();
        // Never guessed at: picking the wrong compute deploys the backend onto
        // shared infrastructure, which is not something to do silently.
        throw new CliError(
          `Could not read this project's compute (deploy-context: ` +
            `${res.status}). Pass --compute <id> to name it.`,
          1,
        );
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
      // `email` is an extra body field, not a column: the before-create hook
      // looks the user up by it and fills in user/userEmail/userName/role/
      // addedBy. Sending userEmail directly is rejected outright.
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
    // No fallback to the production host: `resolveCloudAuth` always stamps
    // extUrl, so the only caller that could omit it is one pointing the client
    // at a stub — and defaulting would send that stub's token to production.
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
        // Both hosts want a scheme: PocketBase strips an optional "Bearer ",
        // and backend-extension's authenticated middleware reads the token as
        // the second whitespace-separated part, so a bare token reads as none.
        "Authorization": `Bearer ${this.auth.userToken}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  }
}
