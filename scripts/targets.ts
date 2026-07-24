// Single source of truth for the platform matrix. The shim's PACKAGE_FOR_HOST,
// the six package.json files, the release archives, and install.sh all derive
// from TARGETS via the pure functions below.

export type Target = {
  /** npm package suffix and directory name, e.g. "darwin-arm64". */
  key: string;
  /** Value of process.platform this package serves. */
  os: string;
  /** Value(s) of process.arch this package may serve. */
  cpu: string[];
  /** --target passed to `deno compile`. */
  denoTarget: string;
  /** Binary filename inside the package. */
  binName: string;
};

/** The five targets Deno 2.5.6 can `compile --target`. */
export const DENO_TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
] as const;

export const TARGETS: Target[] = [
  {
    key: "darwin-arm64",
    os: "darwin",
    cpu: ["arm64"],
    denoTarget: "aarch64-apple-darwin",
    binName: "pb",
  },
  {
    key: "darwin-x64",
    os: "darwin",
    cpu: ["x64"],
    denoTarget: "x86_64-apple-darwin",
    binName: "pb",
  },
  {
    key: "linux-arm64",
    os: "linux",
    cpu: ["arm64"],
    denoTarget: "aarch64-unknown-linux-gnu",
    binName: "pb",
  },
  {
    key: "linux-x64",
    os: "linux",
    cpu: ["x64"],
    denoTarget: "x86_64-unknown-linux-gnu",
    binName: "pb",
  },
  // Deno has no aarch64-pc-windows-msvc; arm64 Windows runs this under emulation.
  {
    key: "win32-x64",
    os: "win32",
    cpu: ["x64", "arm64"],
    denoTarget: "x86_64-pc-windows-msvc",
    binName: "pb.exe",
  },
];

/**
 * Expands each target's `cpu` array into one host entry per architecture,
 * mapping `${process.platform}-${process.arch}` to the package `key` that
 * serves it. win32-x64's ["x64","arm64"] produces both win32-x64 and
 * win32-arm64 pointing at win32-x64 — the emulation fallback.
 */
export function hostMap(targets: Target[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of targets) {
    for (const arch of t.cpu) {
      map[`${t.os}-${arch}`] = t.key;
    }
  }
  return map;
}

/** Release-archive filename, e.g. `pb_0.1.0_darwin_arm64.tar.gz`. */
export function assetName(target: Target, version: string): string {
  const ext = target.os === "win32" ? "zip" : "tar.gz";
  return `pb_${version}_${target.os}_${target.cpu[0]}.${ext}`;
}
