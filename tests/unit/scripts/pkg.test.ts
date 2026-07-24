import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  buildMainPackageJson,
  buildPlatformPackageJson,
  buildShim,
} from "../../../scripts/pkg.ts";
import { type Target, TARGETS } from "../../../scripts/targets.ts";

Deno.test("buildPlatformPackageJson sets name/os/cpu/files and no bin", () => {
  const t = TARGETS.find((x) => x.key === "darwin-arm64") as Target;
  const p = buildPlatformPackageJson(t, "0.1.0");
  assertEquals(p.name, "@pocketbasecloud/cli-darwin-arm64");
  assertEquals(p.version, "0.1.0");
  assertEquals(p.os, ["darwin"]);
  assertEquals(p.cpu, ["arm64"]);
  assertEquals(p.files, ["bin"]);
  assertEquals((p.engines as Record<string, string>).node, ">=18");
  assertEquals("bin" in p, false);
});

Deno.test("win32-x64 package serves both x64 and arm64", () => {
  const t = TARGETS.find((x) => x.key === "win32-x64") as Target;
  const p = buildPlatformPackageJson(t, "0.1.0");
  assertEquals(p.os, ["win32"]);
  assertEquals(p.cpu, ["x64", "arm64"]);
});

Deno.test("buildMainPackageJson pins every target exactly, no ranges", () => {
  const p = buildMainPackageJson("0.1.0");
  assertEquals(p.name, "@pocketbasecloud/cli");
  assertEquals((p.bin as Record<string, string>).pb, "bin/pb.js");
  assertEquals(p.files, ["bin", "README.md"]);
  const deps = p.optionalDependencies as Record<string, string>;
  assertEquals(Object.keys(deps).length, TARGETS.length);
  for (const [name, ver] of Object.entries(deps)) {
    assertMatch(name, /^@pocketbasecloud\/cli-/);
    assertEquals(ver, "0.1.0"); // exact — no ^ or ~
  }
});

Deno.test("buildShim embeds each host key and maps win32-arm64 to win32-x64", () => {
  const shim = buildShim(TARGETS);
  assertStringIncludes(shim, '"darwin-arm64": "darwin-arm64"');
  assertStringIncludes(shim, '"win32-arm64": "win32-x64"');
  assertStringIncludes(shim, "#!/usr/bin/env node");
  assertStringIncludes(shim, "require.resolve");
  // No stray package suffix that was never built.
  assertEquals(shim.includes("cli-win32-arm64"), false);
});
