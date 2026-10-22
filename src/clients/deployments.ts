import type { DeployCommit } from "../git-commit.ts";
import { CliError, httpError } from "../errors.ts";
import type { ResourceKind } from "./types.ts";
import type { ICloudClient } from "./cloud.ts";
import type { RepositoryResult } from "./repo-link.ts";

export type DeployClientConfig = {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
};

async function post<T>(
  path: string,
  body: unknown,
  cfg: DeployClientConfig,
): Promise<T> {
  const fetchFn = cfg.fetchFn ?? fetch;
  const res = await fetchFn(`${cfg.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res, "Deploy");
  const json = await res.json().catch(() => null) as {
    success?: boolean;
    data?: T;
  } | null;
  if (!json?.success) {
    throw new CliError("The platform rejected the deploy request.");
  }
  return json.data as T;
}

export async function uploadArtifact(
  opts: {
    kind: ResourceKind;
    resourceId: string;
    bytes: Uint8Array;
    onProgress?: (fraction: number) => void;
  },
  cfg: DeployClientConfig,
): Promise<string> {
  const fetchFn = cfg.fetchFn ?? fetch;
  const { key, uploadUrl } = await post<{ key: string; uploadUrl: string }>(
    "/api/deployments/upload-url",
    { kind: opts.kind, resourceId: opts.resourceId, input: "artifact" },
    cfg,
  );
  opts.onProgress?.(0);
  const res = await fetchFn(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/zip" },
    body: new Blob([new Uint8Array(opts.bytes)]),
  });
  opts.onProgress?.(1);
  if (!res.ok) {
    throw new CliError(`Upload failed with status ${res.status}`);
  }
  return key;
}

export async function deployArchive(
  opts: {
    kind: ResourceKind;
    resourceId: string;
    bytes: Uint8Array;
    hints?: { pythonVersion?: string };
    baseRevision?: number;
    git?: DeployCommit | null;
    onProgress?: (fraction: number) => void;
  },
  cfg: DeployClientConfig,
): Promise<{ deploymentId: string }> {
  const key = await uploadArtifact(opts, cfg);
  return post<{ deploymentId: string }>(
    "/api/deployments",
    {
      kind: opts.kind,
      resourceId: opts.resourceId,
      input: "artifact",
      artifactKey: key,
      ...(opts.hints ? { hints: opts.hints } : {}),
      ...(opts.baseRevision !== undefined
        ? { baseRevision: opts.baseRevision }
        : {}),
      ...(opts.git ? { git: opts.git } : {}),
    },
    cfg,
  );
}

export async function waitForDeployment(
  deploymentId: string,
  cfg: DeployClientConfig & {
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<{ status: "success" | "failed"; statusMessage: string }> {
  const fetchFn = cfg.fetchFn ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 300_000;
  const intervalMs = cfg.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const res = await fetchFn(
      `${cfg.baseUrl}/api/collections/deployments/records/${deploymentId}`,
      { headers: { Authorization: `Bearer ${cfg.token}` } },
    );
    if (!res.ok) throw await httpError(res, "Checking the deploy");
    const record = await res.json() as {
      status?: string;
      statusMessage?: string;
    };
    if (record.status === "success" || record.status === "failed") {
      return {
        status: record.status,
        statusMessage: record.statusMessage ?? "",
      };
    }
    if (Date.now() > deadline) {
      throw new CliError(
        `Timed out after ${
          Math.round(timeoutMs / 1000)
        }s waiting for the deploy to finish.`,
        { code: "TIMEOUT" },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export type DeploymentRow = {
  id: string;
  resourceId: string;
  status: string;
  statusMessage?: string;
  input?: string;
  gitSha?: string;
  gitTitle?: string;
  gitAuthor?: string;
  requestedBy?: string;
  created: string;
  metadata?:
    | { rollbackOf?: string; revision?: number; message?: string }
    | null;
};

const DEPLOYMENT_FIELDS =
  "id,resourceId,status,statusMessage,input,gitSha,gitTitle,gitAuthor,requestedBy,created,metadata";
const RECENT_DEPLOYMENTS = 20;

export async function listDeployments(
  client: ICloudClient,
  resourceId: string,
): Promise<DeploymentRow[]> {
  const res = await client.pbApi(
    "/api/collections/deployments/records",
    undefined,
    {
      method: "GET",
      query: {
        filter: `resourceId = "${resourceId}"`,
        sort: "-created",
        perPage: String(RECENT_DEPLOYMENTS),
        skipTotal: "true",
        fields: DEPLOYMENT_FIELDS,
      },
    },
  );
  if (!res.ok) throw await httpError(res, "Listing deployments");
  const body = await res.json() as { items?: DeploymentRow[] };
  return body.items ?? [];
}

export async function getDeployment(
  client: ICloudClient,
  deploymentId: string,
): Promise<DeploymentRow> {
  const res = await client.pbApi(
    `/api/collections/deployments/records/${encodeURIComponent(deploymentId)}`,
    undefined,
    { method: "GET", query: { fields: DEPLOYMENT_FIELDS } },
  );
  if (!res.ok) throw await httpError(res, "Reading the deployment");
  return await res.json() as DeploymentRow;
}

export async function requestRollback(
  client: ICloudClient,
  deploymentId: string,
  pushToGit = false,
): Promise<{ deploymentId: string; repository?: RepositoryResult }> {
  const res = await client.ext("/api/deployments/rollback", {
    deploymentId,
    ...(pushToGit && { pushToGit }),
  });
  if (!res.ok) throw await httpError(res, "Rollback");
  const body = await res.json() as {
    data?: { deploymentId?: string; repository?: RepositoryResult };
  };
  if (!body.data?.deploymentId) {
    throw new CliError("The platform rejected the rollback request.", {
      code: "PLATFORM_ERROR",
    });
  }
  return {
    deploymentId: body.data.deploymentId,
    ...(body.data.repository ? { repository: body.data.repository } : {}),
  };
}
