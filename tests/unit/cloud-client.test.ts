import { assertEquals } from "@std/assert";
import { createMockCloudClient } from "../mocks/cloud.mock.ts";
import { mapPbError, PocketBaseCloudClient } from "../../src/clients/cloud.ts";
import { ClientResponseError } from "pocketbase";

/** What PocketBase actually returns when a create fails validation. */
function pbError(
  status: number,
  message: string,
  data: Record<string, { code: string; message: string }> = {},
): ClientResponseError {
  return new ClientResponseError({
    url: "https://backend.example.com/api/collections/frontends/records",
    status,
    response: { code: status, message, data },
  });
}

Deno.test("mapPbError spells out which fields the platform rejected", () => {
  const e = mapPbError(pbError(400, "Failed to create record.", {
    subdomain: {
      code: "validation_required",
      message: "Missing required value.",
    },
    user: { code: "validation_required", message: "Missing required value." },
  }));
  assertEquals(
    e.message,
    "Platform error (400): Failed to create record. — " +
      "subdomain: Missing required value.; user: Missing required value.",
  );
  assertEquals(e.fields, {
    subdomain: "validation_required",
    user: "validation_required",
  });
  assertEquals(e.exitCode, 1);
});

Deno.test("mapPbError leaves a detail-free error as it was", () => {
  const e = mapPbError(pbError(400, "Something broke."));
  assertEquals(e.message, "Platform error (400): Something broke.");
  assertEquals(e.fields, undefined);
});

/**
 * Capture what the client would put on the wire. Both hosts are required —
 * a stub that named only the backend used to have its token sent to the real
 * backend-extension by the `ext()` fallback.
 */
async function capture(
  auth: { backendUrl: string; extUrl: string },
  call: (c: PocketBaseCloudClient) => Promise<Response>,
): Promise<{ url: string; method: string; headers: Headers; body: string }> {
  const original = globalThis.fetch;
  let seen: Request | undefined;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    seen = new Request(String(input), init);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  try {
    await call(
      new PocketBaseCloudClient({ ...auth, userToken: "tok", userId: "u1" }),
    );
    return {
      url: seen!.url,
      method: seen!.method,
      headers: seen!.headers,
      body: await seen!.text(),
    };
  } finally {
    globalThis.fetch = original;
  }
}

const HOSTS = {
  backendUrl: "https://pb.example",
  extUrl: "https://ext.example",
};

Deno.test("ext calls backend-extension, pbApi calls PocketBase", async () => {
  const e = await capture(HOSTS, (c) => c.ext("/api/logs/stream", { a: 1 }));
  assertEquals(e.url, "https://ext.example/api/logs/stream");
  assertEquals(e.method, "POST");
  assertEquals(e.body, '{"a":1}');

  const p = await capture(HOSTS, (c) => c.pbApi("/api/env/set", { a: 1 }));
  assertEquals(p.url, "https://pb.example/api/env/set");
});

Deno.test("both hosts get a Bearer-prefixed token", async () => {
  // backend-extension reads the second whitespace-separated part of the
  // header, so a bare token reads as no token at all.
  const e = await capture(HOSTS, (c) => c.ext("/api/logs/stream", {}));
  assertEquals(e.headers.get("authorization"), "Bearer tok");
  const p = await capture(HOSTS, (c) => c.pbApi("/api/hooks", {}));
  assertEquals(p.headers.get("authorization"), "Bearer tok");
});

Deno.test("a GET carries its query and no body", async () => {
  const got = await capture(
    HOSTS,
    (c) =>
      c.pbApi("/api/hooks", undefined, {
        method: "GET",
        query: { pocketbase_id: "pb1" },
      }),
  );
  assertEquals(got.url, "https://pb.example/api/hooks?pocketbase_id=pb1");
  assertEquals(got.method, "GET");
  assertEquals(got.body, "");
});

Deno.test("mapPbError keeps the auth and permission shortcuts", () => {
  assertEquals(mapPbError(pbError(401, "x")).exitCode, 4);
  assertEquals(mapPbError(pbError(403, "x")).exitCode, 3);
});

Deno.test("mock createResource records the call and returns a resource", async () => {
  const c = createMockCloudClient();
  const r = await c.createResource("pocketbases", {
    name: "db1",
    project: "p1",
  });
  assertEquals(r.name, "db1");
  assertEquals(c.calls.createResource.length, 1);
  assertEquals(c.calls.createResource[0], ["pocketbases", {
    name: "db1",
    project: "p1",
  }]);
});

/**
 * Record every request the PocketBase SDK makes, answering each with a
 * caller-supplied body. Enough to assert what a client method puts on the wire
 * without a live backend.
 */
async function recordSdk(
  call: (c: PocketBaseCloudClient) => Promise<unknown>,
  reply: (url: string) => unknown = () => ({ items: [], totalItems: 0 }),
): Promise<{ url: string; method: string; body: unknown }[]> {
  const original = globalThis.fetch;
  const seen: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const req = new Request(String(input), init);
    const text = await req.text();
    const url = req.url;
    seen.push({
      url,
      method: req.method,
      body: text ? JSON.parse(text) : undefined,
    });
    return new Response(JSON.stringify(reply(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await call(
      new PocketBaseCloudClient({
        backendUrl: "https://pb.example",
        extUrl: "https://ext.example",
        userToken: "tok",
        userId: "u1",
      }),
    );
    return seen;
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("createProject sets the owner, without which the project is invisible", async () => {
  // projects.user is optional in the schema and no hook fills it in for a
  // personal project, but every list/view/update rule keys off it.
  const seen = await recordSdk((c) => c.createProject("app"));
  assertEquals(seen.length, 1);
  assertEquals(seen[0].method, "POST");
  assertEquals(seen[0].body, { name: "app", user: "u1" });
});

Deno.test("deleteProject tombstones rather than hard-deleting", async () => {
  const seen = await recordSdk((c) => c.deleteProject("p1"));
  const write = seen.at(-1)!;
  assertEquals(write.method, "PATCH");
  assertEquals(write.body, { status: "deleted" });
});

Deno.test("deleteProject refuses while resources are still live", async () => {
  let thrown: Error | undefined;
  await recordSdk(
    (c) => c.deleteProject("p1").catch((e: Error) => void (thrown = e)),
    (url) =>
      url.includes("/backends/") ? { items: [{ id: "b1" }], totalItems: 1 } : {
        items: [],
        totalItems: 0,
      },
  );
  // Teardown decrements the slot counter but never cascades, so a project
  // deleted with resources attached would strand running containers.
  assertEquals(
    thrown?.message,
    "Project still has 1 backends. Delete them first.",
  );
});

Deno.test("listResources and listProjects hide tombstones", async () => {
  const res = await recordSdk((c) => c.listResources("backends", "p1"));
  assertEquals(
    decodeURIComponent(new URL(res[0].url).searchParams.get("filter")!),
    'project = "p1" && status != "deleted"',
  );
  const proj = await recordSdk((c) => c.listProjects());
  assertEquals(
    decodeURIComponent(new URL(proj[0].url).searchParams.get("filter")!),
    'status != "deleted"',
  );
});

Deno.test("addMember sends the email the lookup hook reads", async () => {
  // org_members has no `email` column: the before-create hook takes it from
  // the body to find the user, and rejects the create when it is absent.
  const seen = await recordSdk((c) => c.addMember("org1", "dev@e.com"));
  assertEquals(seen[0].body, { organization: "org1", email: "dev@e.com" });
});

Deno.test("mapPbError surfaces the platform's own reason for a 403", () => {
  // The platform's 403s name the actual fix — a slot limit, a plan
  // requirement. Replacing them with a guess about org rights sends the user
  // to the wrong screen entirely.
  const e = mapPbError(
    pbError(
      403,
      "No available PocketBase slots — buy more from the Plan page.",
    ),
  );
  assertEquals(
    e.message,
    "No available PocketBase slots — buy more from the Plan page.",
  );
  assertEquals(e.exitCode, 3);
});

Deno.test("mapPbError falls back to the org-rights hint on a bare 403", () => {
  const e = mapPbError(pbError(403, ""));
  assertEquals(
    e.message,
    "Permission denied. This action may require organization owner rights.",
  );
  assertEquals(e.exitCode, 3);
});

Deno.test("mapPbError surfaces a paused instance on a deploy", () => {
  // `pb cloud pb deploy` writes `status = "uploading"` through the SDK, and the
  // platform's before-update hook refuses it with a sentence naming both ways
  // out. Falling back to the generic org-rights hint here would send a free
  // user who needs to upgrade looking for a permissions problem instead.
  const e = mapPbError(
    pbError(
      403,
      "This instance is paused because it is over the Free plan storage " +
        "limit. Upgrade to resume it, or free up space and it restarts " +
        "automatically.",
    ),
  );
  assertEquals(e.exitCode, 3);
  assertEquals(e.message.includes("paused"), true);
  assertEquals(e.message.includes("organization owner rights"), false);
});
