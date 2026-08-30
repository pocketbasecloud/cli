import { assertEquals } from "@std/assert";
import {
  assetName,
  DENO_TARGETS,
  hostKey,
  hostMap,
  type Target,
  targetForHost,
  TARGETS,
} from "../../../scripts/targets.ts";

Deno.test("every TARGETS denoTarget is one Deno actually supports", () => {
  for (const t of TARGETS) {
    assertEquals(
      DENO_TARGETS.includes(t.denoTarget as (typeof DENO_TARGETS)[number]),
      true,
      `${t.key} has unsupported denoTarget ${t.denoTarget}`,
    );
  }
});

Deno.test("key equals `${os}-${cpu[0]}` for every entry", () => {
  for (const t of TARGETS) {
    assertEquals(t.key, `${t.os}-${t.cpu[0]}`);
  }
});

Deno.test("win32-x64 is the only two-arch entry and pb.exe the only non-pb bin", () => {
  const multiArch = TARGETS.filter((t) => t.cpu.length > 1);
  assertEquals(multiArch.map((t) => t.key), ["win32-x64"]);
  const exe = TARGETS.filter((t) => t.binName !== "pb");
  assertEquals(exe.map((t) => t.binName), ["pb.exe"]);
});

Deno.test("hostMap has one entry per (os, cpu) and maps win32-arm64 to win32-x64", () => {
  const m = hostMap(TARGETS);
  assertEquals(Object.keys(m).length, 6);
  assertEquals(m["darwin-arm64"], "darwin-arm64");
  assertEquals(m["linux-x64"], "linux-x64");
  assertEquals(m["win32-x64"], "win32-x64");
  assertEquals(m["win32-arm64"], "win32-x64");
});

Deno.test("assetName is .tar.gz for Unix and .zip for win32", () => {
  const darwin = TARGETS.find((t) => t.key === "darwin-arm64") as Target;
  const win = TARGETS.find((t) => t.key === "win32-x64") as Target;
  assertEquals(assetName(darwin, "0.1.0"), "pb_0.1.0_darwin_arm64.tar.gz");
  assertEquals(assetName(win, "0.1.0"), "pb_0.1.0_win32_x64.zip");
});

Deno.test("hostKey translates Deno's os/arch names to Node's", () => {
  assertEquals(hostKey("linux", "x86_64"), "linux-x64");
  assertEquals(hostKey("linux", "aarch64"), "linux-arm64");
  assertEquals(hostKey("darwin", "aarch64"), "darwin-arm64");
  assertEquals(hostKey("windows", "x86_64"), "win32-x64");
});

Deno.test("hostKey passes an unknown host through untranslated", () => {
  assertEquals(hostKey("freebsd", "riscv64"), "freebsd-riscv64");
});

Deno.test("targetForHost resolves each supported host to its target", () => {
  assertEquals(targetForHost("linux-x64")?.key, "linux-x64");
  assertEquals(targetForHost("darwin-arm64")?.key, "darwin-arm64");
});

Deno.test("targetForHost maps win32-arm64 to the x64 target it emulates", () => {
  const t = targetForHost("win32-arm64");
  assertEquals(t?.key, "win32-x64");
  assertEquals(t?.binName, "pb.exe");
});

Deno.test("targetForHost returns null for an unsupported host", () => {
  assertEquals(targetForHost("freebsd-x64"), null);
});
