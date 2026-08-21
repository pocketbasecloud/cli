import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assetUrl,
  checksumsUrl,
  fetchManifest,
  hostAsset,
  parseChecksums,
} from "../../../src/self/release.ts";
import { CliError } from "../../../src/errors.ts";

const CHECKSUMS = [
  "aaaa  pb_0.2.4_darwin_arm64.tar.gz",
  "bbbb  pb_0.2.4_darwin_x64.tar.gz",
  "cccc  pb_0.2.4_linux_arm64.tar.gz",
  "dddd  pb_0.2.4_linux_x64.tar.gz",
  "eeee  pb_0.2.4_win32_x64.zip",
].join("\n") + "\n";

Deno.test("checksumsUrl uses the latest redirect when no version is given", () => {
  assertEquals(
    checksumsUrl(),
    "https://github.com/pocketbasecloud/cli/releases/latest/download/checksums.txt",
  );
  assertEquals(
    checksumsUrl("0.2.4"),
    "https://github.com/pocketbasecloud/cli/releases/download/v0.2.4/checksums.txt",
  );
});

Deno.test("assetUrl points at the tagged release", () => {
  assertEquals(
    assetUrl("0.2.4", "pb_0.2.4_linux_x64.tar.gz"),
    "https://github.com/pocketbasecloud/cli/releases/download/v0.2.4/pb_0.2.4_linux_x64.tar.gz",
  );
});

Deno.test("parseChecksums reads the version out of the asset names", () => {
  const m = parseChecksums(CHECKSUMS);
  assertEquals(m.version, "0.2.4");
  assertEquals(m.checksums["pb_0.2.4_linux_x64.tar.gz"], "dddd");
  assertEquals(m.checksums["pb_0.2.4_win32_x64.zip"], "eeee");
});

Deno.test("parseChecksums lowercases digests and tolerates blank lines", () => {
  const m = parseChecksums(`\n\nDEADBEEF  pb_1.0.0_linux_x64.tar.gz\n\n`);
  assertEquals(m.version, "1.0.0");
  assertEquals(m.checksums["pb_1.0.0_linux_x64.tar.gz"], "deadbeef");
});

Deno.test("parseChecksums reads a prerelease version", () => {
  const m = parseChecksums("aaaa  pb_1.0.0-rc.1_linux_x64.tar.gz");
  assertEquals(m.version, "1.0.0-rc.1");
});

Deno.test("parseChecksums keeps non-matching entries but still needs one version", () => {
  const m = parseChecksums(
    "aaaa  SOURCE.txt\nbbbb  pb_0.3.0_linux_x64.tar.gz\n",
  );
  assertEquals(m.version, "0.3.0");
  assertEquals(m.checksums["SOURCE.txt"], "aaaa");
});

Deno.test("parseChecksums throws when no asset name carries a version", () => {
  assertThrows(
    () => parseChecksums("aaaa  something-else.txt\n"),
    CliError,
    "Could not read a version",
  );
});

Deno.test("hostAsset maps each supported host to its archive", () => {
  assertEquals(
    hostAsset("linux-x64", "0.2.4").name,
    "pb_0.2.4_linux_x64.tar.gz",
  );
  assertEquals(
    hostAsset("darwin-arm64", "0.2.4").name,
    "pb_0.2.4_darwin_arm64.tar.gz",
  );
  assertEquals(hostAsset("linux-x64", "0.2.4").target.binName, "pb");
});

Deno.test("hostAsset serves win32-arm64 from the emulated x64 archive", () => {
  const { target, name } = hostAsset("win32-arm64", "0.2.4");
  assertEquals(name, "pb_0.2.4_win32_x64.zip");
  assertEquals(target.binName, "pb.exe");
  assertEquals(target.key, "win32-x64");
});

Deno.test("hostAsset rejects a host with no prebuilt binary", () => {
  assertThrows(
    () => hostAsset("freebsd-x64", "0.2.4"),
    CliError,
    "No prebuilt pbc binary for freebsd-x64",
  );
});

function fetchReturning(res: () => Response | Promise<Response>): typeof fetch {
  return (() => Promise.resolve(res())) as unknown as typeof fetch;
}

Deno.test("fetchManifest parses a successful response", async () => {
  const m = await fetchManifest(
    fetchReturning(() => new Response(CHECKSUMS, { status: 200 })),
  );
  assertEquals(m.version, "0.2.4");
});

Deno.test("fetchManifest reports an unknown version as a usage error", async () => {
  const e = await assertRejects(
    () =>
      fetchManifest(
        fetchReturning(() => new Response("Not Found", { status: 404 })),
        "9.9.9",
      ),
    CliError,
    "pbc 9.9.9 is not a published release",
  );
  assertEquals(e.exitCode, 2);
});

Deno.test("fetchManifest surfaces a server error without claiming a version", async () => {
  await assertRejects(
    () =>
      fetchManifest(
        fetchReturning(() => new Response("nope", { status: 503 })),
      ),
    CliError,
    "Could not fetch the release manifest (503)",
  );
});

Deno.test("fetchManifest turns a network failure into a clear message", async () => {
  await assertRejects(
    () =>
      fetchManifest(
        (() =>
          Promise.reject(
            new TypeError("dns failure"),
          )) as unknown as typeof fetch,
      ),
    CliError,
    "Could not reach GitHub",
  );
});
