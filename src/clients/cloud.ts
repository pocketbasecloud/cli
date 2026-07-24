import PocketBase, { ClientResponseError } from "pocketbase";
import type { CloudAuth } from "../config.ts";
import { CliError } from "../errors.ts";
import type { Org, Project, Resource, ResourceKind, User } from "./types.ts";

export interface ICloudClient {
  whoami(): Promise<User>;
  listProjects(orgId?: string): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
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
  listOrgs(): Promise<Org[]>;
  createOrg(name: string): Promise<Org>;
  deleteOrg(id: string): Promise<void>;
  listMembers(orgId: string): Promise<{ email: string; role: string }[]>;
  addMember(orgId: string, email: string): Promise<void>;
  removeMember(orgId: string, email: string): Promise<void>;
  shareProject(projectId: string, orgId: string | null): Promise<void>;
  ext(path: string, body: unknown): Promise<Response>;
}

export function mapPbError(e: unknown): CliError {
  if (e instanceof ClientResponseError) {
    if (e.status === 403) {
      return new CliError(
        "Permission denied. This action may require organization owner rights.",
        3,
      );
    }
    if (e.status === 401) {
      return new CliError("Not authenticated. Run `pb cloud login`.", 4);
    }
    const msg = e.response?.message ?? e.message;
    return new CliError(`Platform error (${e.status}): ${msg}`, 1);
  }
  return new CliError(String(e), 1);
}

export class PocketBaseCloudClient implements ICloudClient {
  private pb: PocketBase;
  constructor(private auth: CloudAuth) {
    this.pb = new PocketBase(auth.backendUrl);
    this.pb.authStore.save(auth.userToken, null);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw mapPbError(e);
    }
  }

  whoami(): Promise<User> {
    return this.guard(async () => {
      const rec = await this.pb.collection("users").authRefresh();
      const u = rec.record as unknown as {
        id: string;
        email: string;
        plan: string;
      };
      return { id: u.id, email: u.email, plan: u.plan ?? "free" };
    });
  }

  listProjects(orgId?: string): Promise<Project[]> {
    return this.guard(async () => {
      const filter = orgId ? `organization = "${orgId}"` : "";
      const recs = await this.pb.collection("projects").getFullList({ filter });
      return recs as unknown as Project[];
    });
  }

  createProject(name: string): Promise<Project> {
    return this.guard(async () =>
      await this.pb.collection("projects").create({
        name,
      }) as unknown as Project
    );
  }

  deleteProject(id: string): Promise<void> {
    return this.guard(async () => {
      await this.pb.collection("projects").delete(id);
    });
  }

  listResources(kind: ResourceKind, projectId: string): Promise<Resource[]> {
    return this.guard(async () =>
      await this.pb.collection(kind).getFullList({
        filter: `project = "${projectId}"`,
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
        userEmail: email,
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

  ext(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.auth.backendUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": this.auth.userToken,
      },
      body: JSON.stringify(body),
    });
  }
}
