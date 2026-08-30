import { assertEquals, assertRejects } from "@std/assert";
import {
  assetUrl,
  checksumsUrl,
  compareSemverDesc,
  FALLBACK_VERSIONS,
  listVersions,
  normalizeVersion,
  resolveLatest,
} from "../../../src/local/releases.ts";
import { CliError, EXIT_CODES } from "../../../src/errors.ts";

type Release = { tag_name: string; draft: boolean; prerelease: boolean };

function releasesResponse(rels: Release[]): Response {
  return new Response(JSON.stringify(rels), { status: 200 });
}

const INTERLEAVED: Release[] = [
  { tag_name: "v0.39.9", draft: false, prerelease: false },
  { tag_name: "v0.22.50", draft: false, prerelease: false },
  { tag_name: "v0.39.8", draft: false, prerelease: false },
  { tag_name: "v0.22.49", draft: false, prerelease: false },
];

function stubFetch(res: Response | (() => never)) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => headers[k] = v);
    calls.push({ url: String(input), headers });
    if (typeof res === "function") return res();
    return Promise.resolve(res.clone());
  }) as unknown as typeof fetch;
  return { fn, calls };
}

Deno.test("normalizeVersion strips a leading v", () => {
  assertEquals(normalizeVersion("v0.39.9"), "0.39.9");
  assertEquals(normalizeVersion("0.39.9"), "0.39.9");
});

Deno.test("compareSemverDesc orders numerically, not lexically", () => {
  const sorted = ["0.9.1", "0.22.50", "0.39.9", "0.39.10"].sort(
    compareSemverDesc,
  );
  assertEquals(sorted, ["0.39.10", "0.39.9", "0.22.50", "0.9.1"]);
});

Deno.test("listVersions sorts interleaved release lines by semver", async () => {
  const { fn } = stubFetch(releasesResponse(INTERLEAVED));
  const got = await listVersions({ fetch: fn, env: () => undefined });
  assertEquals(got.source, "github");
  assertEquals(got.versions, ["0.39.9", "0.39.8", "0.22.50", "0.22.49"]);
});

Deno.test("listVersions drops drafts and prereleases by default", async () => {
  const { fn } = stubFetch(releasesResponse([
    { tag_name: "v0.40.0-rc1", draft: false, prerelease: true },
    { tag_name: "v0.39.9", draft: false, prerelease: false },
    { tag_name: "v0.39.10", draft: true, prerelease: false },
  ]));
  const got = await listVersions({ fetch: fn, env: () => undefined });
  assertEquals(got.versions, ["0.39.9"]);
});

Deno.test("listVersions includes prereleases with pre:true but never drafts", async () => {
  const { fn } = stubFetch(releasesResponse([
    { tag_name: "v0.40.0-rc1", draft: false, prerelease: true },
    { tag_name: "v0.39.9", draft: false, prerelease: false },
    { tag_name: "v0.39.10", draft: true, prerelease: false },
  ]));
  const got = await listVersions({ fetch: fn, env: () => undefined }, {
    pre: true,
  });
  assertEquals(got.versions, ["0.40.0-rc1", "0.39.9"]);
});

Deno.test("listVersions caps at 20 unless all:true", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    tag_name: `v0.39.${i}`,
    draft: false,
    prerelease: false,
  }));
  const { fn } = stubFetch(releasesResponse(many));
  assertEquals(
    (await listVersions({ fetch: fn, env: () => undefined })).versions.length,
    20,
  );
  assertEquals(
    (await listVersions({ fetch: fn, env: () => undefined }, { all: true }))
      .versions.length,
    30,
  );
});

Deno.test("listVersions falls back to the builtin list on a network error", async () => {
  const { fn } = stubFetch(() => {
    throw new TypeError("error sending request");
  });
  const got = await listVersions({ fetch: fn, env: () => undefined });
  assertEquals(got.source, "builtin");
  assertEquals(got.versions, [...FALLBACK_VERSIONS]);
});

Deno.test("listVersions falls back on a 403 rate limit", async () => {
  const { fn } = stubFetch(new Response("rate limited", { status: 403 }));
  assertEquals(
    (await listVersions({ fetch: fn, env: () => undefined })).source,
    "builtin",
  );
});

Deno.test("listVersions falls back on a 5xx", async () => {
  const { fn } = stubFetch(new Response("boom", { status: 502 }));
  assertEquals(
    (await listVersions({ fetch: fn, env: () => undefined })).source,
    "builtin",
  );
});

Deno.test("listVersions sends GITHUB_TOKEN when present", async () => {
  const { fn, calls } = stubFetch(releasesResponse(INTERLEAVED));
  await listVersions({
    fetch: fn,
    env: (k) => k === "GITHUB_TOKEN" ? "ghp_x" : undefined,
  });
  assertEquals(calls[0].headers["authorization"], "Bearer ghp_x");
});

Deno.test("listVersions prefers GITHUB_TOKEN over GH_TOKEN", async () => {
  const { fn, calls } = stubFetch(releasesResponse(INTERLEAVED));
  await listVersions({
    fetch: fn,
    env: (k) => k === "GITHUB_TOKEN" ? "primary" : "secondary",
  });
  assertEquals(calls[0].headers["authorization"], "Bearer primary");
});

Deno.test("listVersions sends no auth header without a token", async () => {
  const { fn, calls } = stubFetch(releasesResponse(INTERLEAVED));
  await listVersions({ fetch: fn, env: () => undefined });
  assertEquals(calls[0].headers["authorization"], undefined);
});

Deno.test("resolveLatest returns the newest stable version", async () => {
  const { fn } = stubFetch(releasesResponse(INTERLEAVED));
  assertEquals(
    await resolveLatest({ fetch: fn, env: () => undefined }),
    "0.39.9",
  );
});

Deno.test("resolveLatest refuses to guess from the builtin list", async () => {
  const { fn } = stubFetch(() => {
    throw new TypeError("offline");
  });
  const e = await assertRejects(
    () => resolveLatest({ fetch: fn, env: () => undefined }),
    CliError,
  );
  assertEquals((e as CliError).exitCode, EXIT_CODES.PLATFORM);
  assertEquals((e as Error).message.includes("explicit version"), true);
});

Deno.test("assetUrl and checksumsUrl point at the tagged release", () => {
  assertEquals(
    assetUrl("0.39.9", "pocketbase_0.39.9_darwin_arm64.zip"),
    "https://github.com/pocketbase/pocketbase/releases/download/v0.39.9/pocketbase_0.39.9_darwin_arm64.zip",
  );
  assertEquals(
    checksumsUrl("0.39.9"),
    "https://github.com/pocketbase/pocketbase/releases/download/v0.39.9/checksums.txt",
  );
});
