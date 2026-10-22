import { assertEquals } from "@std/assert";
import {
  deployArchive,
  waitForDeployment,
} from "../../src/clients/deployments.ts";

Deno.test({
  name:
    "deployArchive requests a URL, PUTs the bytes, then creates the deployment",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const seen: string[] = [];
    const fetchFn = ((input: Request | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/upload-url")) {
        return Promise.resolve(
          new Response(JSON.stringify({
            success: true,
            data: { key: "deploys/u_1/a.zip", uploadUrl: "https://r2/put" },
          })),
        );
      }
      if (url === "https://r2/put") {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({
          success: true,
          data: { deploymentId: "dep1" },
        })),
      );
    }) as unknown as typeof fetch;

    const result = await deployArchive({
      kind: "frontends",
      resourceId: "fe1",
      bytes: new Uint8Array([1, 2, 3]),
    }, { fetchFn, baseUrl: "https://api", token: "t" });

    assertEquals(result.deploymentId, "dep1");
    assertEquals(seen[0], "POST https://api/api/deployments/upload-url");
    assertEquals(seen[1], "PUT https://r2/put");
    assertEquals(seen[2], "POST https://api/api/deployments");
  },
});

Deno.test({
  name: "waitForDeployment returns the platform's composed failure sentence",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fetchFn = (() =>
      Promise.resolve(
        new Response(JSON.stringify({
          id: "dep1",
          status: "failed",
          statusMessage: "Your build ran out of memory.",
        })),
      )) as unknown as typeof fetch;

    const result = await waitForDeployment("dep1", {
      fetchFn,
      baseUrl: "https://api",
      token: "t",
      intervalMs: 1,
    });

    assertEquals(result.status, "failed");
    assertEquals(result.statusMessage, "Your build ran out of memory.");
  },
});

Deno.test("deployArchive sends the base revision only when given", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/upload-url")) {
      return Promise.resolve(Response.json({
        success: true,
        data: { key: "deploys/u/x.zip", uploadUrl: "https://r2/put" },
      }));
    }
    if (url === "https://r2/put") return Promise.resolve(new Response(null));
    bodies.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      Response.json({ success: true, data: { deploymentId: "d1" } }),
    );
  }) as typeof fetch;
  const cfg = { baseUrl: "https://ext", token: "t", fetchFn };
  const bytes = new Uint8Array([1]);
  await deployArchive({
    kind: "pocketbases",
    resourceId: "pb1",
    bytes,
    baseRevision: 5,
  }, cfg);
  await deployArchive({ kind: "pocketbases", resourceId: "pb1", bytes }, cfg);
  assertEquals(bodies.map((b) => b.baseRevision), [5, undefined]);
});
