import { assertEquals, assertRejects } from "@std/assert";
import {
  assetUrl,
  checksumsUrl,
  compareSemverDesc,
  DOWNLOAD_BASES,
  FALLBACK_VERSIONS,
  listVersions,
  normalizeVersion,
  resolveLatest,
} from "../../../src/local/releases.ts";
import { CliError, EXIT_CODES } from "../../../src/errors.ts";

type Release = { tag_name: string; draft: boolean; prerelease: boolean };
type HostRelease = { tag: string; draft: boolean; files: string[] };

const NEW_HOST_API = "https://ganigeorgiev.com/api/";

function releasesResponse(rels: Release[]): Response {
  return new Response(JSON.stringify(rels), { status: 200 });
}

function hostResponse(rels: HostRelease[]): Response {
  return new Response(JSON.stringify({ items: rels }), { status: 200 });
}

function pbRelease(tag: string, draft = false): HostRelease {
  const v = tag.replace(/^v/, "");
  return {
    tag,
    draft,
    files: ["checksums.txt", `pocketbase_${v}_linux_amd64.zip`],
  };
}

const INTERLEAVED: Release[] = [
  { tag_name: "v0.39.9", draft: false, prerelease: false },
  { tag_name: "v0.22.50", draft: false, prerelease: false },
  { tag_name: "v0.39.8", draft: false, prerelease: false },
  { tag_name: "v0.22.49", draft: false, prerelease: false },
];

type Stub = Response | (() => never);

function stubFetch(github: Stub, host: Stub = hostResponse([])) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => headers[k] = v);
    const url = String(input);
    calls.push({ url, headers });
    const res = url.startsWith(NEW_HOST_API) ? host : github;
    if (typeof res === "function") return res();
    return Promise.resolve(res.clone());
  }) as unknown as typeof fetch;
  const githubCall = () => calls.find((c) => !c.url.startsWith(NEW_HOST_API))!;
  const hostCall = () => calls.find((c) => c.url.startsWith(NEW_HOST_API))!;
  return { fn, calls, githubCall, hostCall };
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

Deno.test("compareSemverDesc orders prereleases by semver rules", () => {
  const sorted = [
    "0.40.0-beta.2",
    "0.40.0",
    "0.40.0-rc.1",
    "0.40.0-beta.10",
  ].sort(compareSemverDesc);
  assertEquals(sorted, [
    "0.40.0",
    "0.40.0-rc.1",
    "0.40.0-beta.10",
    "0.40.0-beta.2",
  ]);
  assertEquals(compareSemverDesc("0.40.0-beta.10", "0.40.0-beta.2"), -1);
  assertEquals(compareSemverDesc("0.40.0-rc.1", "0.40.0-beta.9"), -1);
});

Deno.test("listVersions sorts interleaved release lines by semver", async () => {
  const { fn } = stubFetch(releasesResponse(INTERLEAVED));
  const got = await listVersions({ fetch: fn, env: () => undefined });
  assertEquals(got.source, "github");
  assertEquals(got.versions, ["0.39.9", "0.39.8", "0.22.50", "0.22.49"]);
});

Deno.test("listVersions merges new host PocketBase releases with GitHub's", async () => {
  const { fn } = stubFetch(
    releasesResponse(INTERLEAVED),
    hostResponse([
      pbRelease("v0.41.0"),
      pbRelease("v0.22.58"),
      pbRelease("v0.39.9"),
      pbRelease("v0.42.0", true),
      {
        tag: "v3.4.73",
        draft: false,
        files: ["checksums.txt", "presentator_3.4.73_linux_amd64.zip"],
      },
    ]),
  );
  const got = await listVersions({ fetch: fn, env: () => undefined });
  assertEquals(got.versions, [
    "0.41.0",
    "0.39.9",
    "0.39.8",
    "0.22.58",
    "0.22.50",
    "0.22.49",
  ]);
});

Deno.test("listVersions treats hyphenated new host tags as prereleases", async () => {
  const { fn } = stubFetch(
    releasesResponse([]),
    hostResponse([pbRelease("v0.42.0-rc.1"), pbRelease("v0.41.0")]),
  );
  const env = () => undefined;
  assertEquals((await listVersions({ fetch: fn, env })).versions, ["0.41.0"]);
  assertEquals(
    (await listVersions({ fetch: fn, env }, { pre: true })).versions,
    ["0.42.0-rc.1", "0.41.0"],
  );
});

Deno.test("listVersions falls back when the new host fails", async () => {
  const { fn } = stubFetch(
    releasesResponse(INTERLEAVED),
    new Response("boom", { status: 502 }),
  );
  assertEquals(
    (await listVersions({ fetch: fn, env: () => undefined })).source,
    "builtin",
  );
});

Deno.test("listVersions never sends GITHUB_TOKEN to the new host", async () => {
  const { fn, hostCall } = stubFetch(releasesResponse(INTERLEAVED));
  await listVersions({
    fetch: fn,
    env: (k) => k === "GITHUB_TOKEN" ? "ghp_x" : undefined,
  });
  assertEquals(hostCall().headers["authorization"], undefined);
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
  const { fn, githubCall } = stubFetch(releasesResponse(INTERLEAVED));
  await listVersions({
    fetch: fn,
    env: (k) => k === "GITHUB_TOKEN" ? "ghp_x" : undefined,
  });
  assertEquals(githubCall().headers["authorization"], "Bearer ghp_x");
});

Deno.test("listVersions prefers GITHUB_TOKEN over GH_TOKEN", async () => {
  const { fn, githubCall } = stubFetch(releasesResponse(INTERLEAVED));
  await listVersions({
    fetch: fn,
    env: (k) => k === "GITHUB_TOKEN" ? "primary" : "secondary",
  });
  assertEquals(githubCall().headers["authorization"], "Bearer primary");
});

Deno.test("listVersions sends no auth header without a token", async () => {
  const { fn, githubCall } = stubFetch(releasesResponse(INTERLEAVED));
  await listVersions({ fetch: fn, env: () => undefined });
  assertEquals(githubCall().headers["authorization"], undefined);
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

Deno.test("assetUrl and checksumsUrl point at the tagged release on a host", () => {
  const github = "https://github.com/pocketbase/pocketbase/releases/download";
  assertEquals(
    assetUrl("0.39.9", "pocketbase_0.39.9_darwin_arm64.zip", github),
    `${github}/v0.39.9/pocketbase_0.39.9_darwin_arm64.zip`,
  );
  assertEquals(
    checksumsUrl("0.39.9", github),
    `${github}/v0.39.9/checksums.txt`,
  );
});

Deno.test("DOWNLOAD_BASES lists the new host before GitHub", () => {
  assertEquals(DOWNLOAD_BASES, [
    "https://ganigeorgiev.com/meta/pocketbase/pocketbase/download",
    "https://github.com/pocketbase/pocketbase/releases/download",
  ]);
});
