import { assertEquals } from "@std/assert";
import {
  assetName,
  DENO_TARGETS,
  hostMap,
  type Target,
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
  // 4 single-arch + 2 win32 arches = 6 host entries.
  assertEquals(Object.keys(m).length, 6);
  assertEquals(m["darwin-arm64"], "darwin-arm64");
  assertEquals(m["linux-x64"], "linux-x64");
  assertEquals(m["win32-x64"], "win32-x64");
  // The case a naive `${platform}-${arch}` concat gets wrong:
  assertEquals(m["win32-arm64"], "win32-x64");
});

Deno.test("assetName is .tar.gz for Unix and .zip for win32", () => {
  const darwin = TARGETS.find((t) => t.key === "darwin-arm64") as Target;
  const win = TARGETS.find((t) => t.key === "win32-x64") as Target;
  assertEquals(assetName(darwin, "0.1.0"), "pb_0.1.0_darwin_arm64.tar.gz");
  assertEquals(assetName(win, "0.1.0"), "pb_0.1.0_win32_x64.zip");
});
