import { CliError, httpError } from "../errors.ts";
import type { ResourceKind } from "./types.ts";

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

export function deployArchive(
  opts: {
    kind: ResourceKind;
    resourceId: string;
    bytes: Uint8Array;
    onProgress?: (fraction: number) => void;
  },
  cfg: DeployClientConfig,
): Promise<{ deploymentId: string }> {
  const fetchFn = cfg.fetchFn ?? fetch;
  const payload = new Blob([new Uint8Array(opts.bytes)]);
  return post<{ key: string; uploadUrl: string }>(
    "/api/deployments/upload-url",
    { kind: opts.kind, resourceId: opts.resourceId, input: "artifact" },
    cfg,
  ).then(async ({ key, uploadUrl }) => {
    opts.onProgress?.(0);
    const res = await fetchFn(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/zip" },
      body: payload,
    });
    opts.onProgress?.(1);
    if (!res.ok) {
      throw new CliError(`Upload failed with status ${res.status}`);
    }
    return post<{ deploymentId: string }>(
      "/api/deployments",
      {
        kind: opts.kind,
        resourceId: opts.resourceId,
        input: "artifact",
        artifactKey: key,
      },
      cfg,
    );
  });
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
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the deploy to finish.`,
        { code: "TIMEOUT" },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
