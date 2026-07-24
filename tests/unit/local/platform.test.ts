import { assertEquals, assertThrows } from "@std/assert";
import { detectPlatform } from "../../../src/local/platform.ts";
import { CliError } from "../../../src/errors.ts";

Deno.test("detectPlatform maps darwin/aarch64 to darwin_arm64", () => {
  const p = detectPlatform({ hostOs: "darwin", hostArch: "aarch64" });
  assertEquals(p.os, "darwin");
  assertEquals(p.arch, "arm64");
  assertEquals(p.assetName("0.39.9"), "pocketbase_0.39.9_darwin_arm64.zip");
  assertEquals(p.binName, "pocketbase");
});

Deno.test("detectPlatform maps linux/x86_64 to linux_amd64", () => {
  const p = detectPlatform({ hostOs: "linux", hostArch: "x86_64" });
  assertEquals(p.assetName("0.22.50"), "pocketbase_0.22.50_linux_amd64.zip");
  assertEquals(p.binName, "pocketbase");
});

Deno.test("detectPlatform uses pocketbase.exe on windows", () => {
  const p = detectPlatform({ hostOs: "windows", hostArch: "x86_64" });
  assertEquals(p.assetName("0.39.9"), "pocketbase_0.39.9_windows_amd64.zip");
  assertEquals(p.binName, "pocketbase.exe");
});

Deno.test("detectPlatform lets --os/--arch override the host", () => {
  const p = detectPlatform({
    hostOs: "darwin",
    hostArch: "aarch64",
    os: "linux",
    arch: "armv7",
  });
  assertEquals(p.assetName("0.39.9"), "pocketbase_0.39.9_linux_armv7.zip");
  assertEquals(p.binName, "pocketbase");
});

Deno.test("detectPlatform rejects an unsupported host os", () => {
  const e = assertThrows(
    () => detectPlatform({ hostOs: "freebsd", hostArch: "x86_64" }),
    CliError,
  );
  assertEquals((e as CliError).exitCode, 2);
  assertEquals((e as Error).message.includes("freebsd"), true);
  assertEquals((e as Error).message.includes("darwin"), true);
});

Deno.test("detectPlatform rejects an unsupported host arch", () => {
  const e = assertThrows(
    () => detectPlatform({ hostOs: "linux", hostArch: "riscv64" }),
    CliError,
  );
  assertEquals((e as CliError).exitCode, 2);
  assertEquals((e as Error).message.includes("riscv64"), true);
});

Deno.test("detectPlatform rejects an unsupported --os override", () => {
  assertThrows(
    () => detectPlatform({ hostOs: "linux", hostArch: "x86_64", os: "plan9" }),
    CliError,
  );
});
