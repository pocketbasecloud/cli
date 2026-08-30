import type { CloudCmdDeps } from "../../src/commands/project.ts";

export type MockDeployFetch = {
  fetchFn: NonNullable<CloudCmdDeps["fetch"]>;
  calls: { method: string; url: string; bodyBytes?: Uint8Array }[];
  setStatus: (status: "success" | "failed", statusMessage?: string) => void;
};

const DEPLOYMENT_URL_PATTERNS = [
  "/api/deployments/upload-url",
  "/api/deployments",
  "/api/collections/deployments/records/",
];

function isDeploymentUrl(url: string): boolean {
  return DEPLOYMENT_URL_PATTERNS.some((p) => url.includes(p));
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function bodyBytesOf(
  body: BodyInit | null | undefined,
): Promise<Uint8Array | undefined> {
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof Uint8Array) return body;
  return undefined;
}

export function createMockDeployFetch(
  opts: { fallback?: NonNullable<CloudCmdDeps["fetch"]> } = {},
): MockDeployFetch {
  const calls: MockDeployFetch["calls"] = [];
  const state = { status: "success", statusMessage: "" as string | undefined };

  const fetchFn: NonNullable<CloudCmdDeps["fetch"]> = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof Request
      ? input.url
      : input.href;
    const method = init?.method ?? "GET";
    if (url === "https://r2/put") {
      calls.push({ method, url, bodyBytes: await bodyBytesOf(init?.body) });
      return new Response(null, { status: 200 });
    }
    if (!isDeploymentUrl(url)) {
      if (opts.fallback) return opts.fallback(input, init);
      throw new Error(`Unexpected fetch in a deploy test: ${method} ${url}`);
    }
    calls.push({ method, url, bodyBytes: await bodyBytesOf(init?.body) });
    if (url.endsWith("/api/deployments/upload-url")) {
      return json({
        success: true,
        data: { key: "deploys/u_1/x.zip", uploadUrl: "https://r2/put" },
      });
    }
    if (url.endsWith("/api/deployments")) {
      return json({ success: true, data: { deploymentId: "dep_1" } });
    }
    return json({
      id: "dep_1",
      status: state.status,
      statusMessage: state.statusMessage,
    });
  };

  return {
    fetchFn,
    calls,
    setStatus(status, statusMessage) {
      state.status = status;
      state.statusMessage = statusMessage;
    },
  };
}
