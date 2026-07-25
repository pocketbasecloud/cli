import type { ICloudClient } from "../../src/clients/cloud.ts";
import type {
  Org,
  Project,
  Resource,
  ResourceKind,
  Server,
  User,
} from "../../src/clients/types.ts";

export type MockCloudClient = ICloudClient & {
  calls: {
    createResource: [ResourceKind, Record<string, unknown>][];
    updateResource: [ResourceKind, string, Record<string, unknown>][];
    shareProject: [string, string | null][];
    ext: [string, unknown][];
    pbApi: [string, unknown][];
  };
  projects: Project[];
  resources: Resource[];
  orgs: Org[];
  servers: Server[];
};

export function createMockCloudClient(
  overrides: Partial<ICloudClient> = {},
): MockCloudClient {
  const calls: MockCloudClient["calls"] = {
    createResource: [],
    updateResource: [],
    shareProject: [],
    ext: [],
    pbApi: [],
  };
  const state = {
    projects: [] as Project[],
    resources: [] as Resource[],
    orgs: [] as Org[],
    servers: [] as Server[],
  };
  let seq = 0;
  const id = () => `mock${++seq}`;
  /** Resource id -> kind, so listResources can filter by kind like the real API. */
  const kinds = new Map<string, ResourceKind>();

  const base: ICloudClient = {
    whoami: () =>
      Promise.resolve({ id: "u1", email: "u@e.com", plan: "pro" } as User),
    listProjects: (orgId?: string) =>
      Promise.resolve(
        orgId
          ? state.projects.filter((p) => p.organization === orgId)
          : state.projects,
      ),
    createProject: (name: string) => {
      const p: Project = {
        id: id(),
        name,
        user: "u1",
        organization: "",
        createdBy: "u1",
      };
      state.projects.push(p);
      return Promise.resolve(p);
    },
    deleteProject: () => Promise.resolve(),
    listResources: (kind, projectId) =>
      Promise.resolve(
        state.resources.filter((r) =>
          r.project === projectId && kinds.get(r.id) === kind &&
          // The real client filters tombstones out, so a deleted resource
          // must not be findable by name here either.
          r.status !== "deleted"
        ),
      ),
    createResource: (kind, data) => {
      calls.createResource.push([kind, data]);
      const r: Resource = {
        id: id(),
        name: String(data.name ?? ""),
        status: "provisioning",
        project: String(data.project ?? ""),
        createdBy: "u1",
      };
      state.resources.push(r);
      kinds.set(r.id, kind);
      return Promise.resolve(r);
    },
    updateResource: (kind, rid, data) => {
      calls.updateResource.push([kind, rid, data]);
      const existing = state.resources.find((x) => x.id === rid);
      const merged = {
        ...(existing ??
          {
            id: rid,
            name: "",
            status: "running",
            project: "",
            createdBy: "u1",
          }),
        ...data,
      } as Resource;
      if (existing) Object.assign(existing, merged);
      return Promise.resolve(merged);
    },
    getResource: (_k, rid) =>
      Promise.resolve(
        state.resources.find((x) => x.id === rid) ??
          {
            id: rid,
            name: "",
            status: "running",
            project: "",
            createdBy: "u1",
          },
      ),
    listServers: () => Promise.resolve(state.servers),
    listOrgs: () => Promise.resolve(state.orgs),
    createOrg: (name) => {
      const o: Org = { id: id(), name, owner: "u1", role: "owner" };
      state.orgs.push(o);
      return Promise.resolve(o);
    },
    deleteOrg: () => Promise.resolve(),
    listMembers: () => Promise.resolve([]),
    addMember: () => Promise.resolve(),
    removeMember: () => Promise.resolve(),
    shareProject: (pid, orgId) => {
      calls.shareProject.push([pid, orgId]);
      return Promise.resolve();
    },
    fileToken: () => Promise.resolve("filetoken"),
    ext: (path, body) => {
      calls.ext.push([path, body]);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    },
    pbApi: (path, body) => {
      calls.pbApi.push([path, body]);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    },
    ...overrides,
  };

  return Object.assign(base, { calls, ...state });
}
