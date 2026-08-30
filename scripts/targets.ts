export type Target = {
  key: string;
  os: string;
  cpu: string[];
  denoTarget: string;
  binName: string;
};

export const CLI_NAME = "pbc";
export const LEGACY_CLI_NAME = "pb";

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
  {
    key: "win32-x64",
    os: "win32",
    cpu: ["x64", "arm64"],
    denoTarget: "x86_64-pc-windows-msvc",
    binName: "pb.exe",
  },
];

export function hostMap(targets: Target[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of targets) {
    for (const arch of t.cpu) {
      map[`${t.os}-${arch}`] = t.key;
    }
  }
  return map;
}

export function assetName(target: Target, version: string): string {
  const ext = target.os === "win32" ? "zip" : "tar.gz";
  return `pb_${version}_${target.os}_${target.cpu[0]}.${ext}`;
}

const OS_FROM_DENO: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  windows: "win32",
};
const ARCH_FROM_DENO: Record<string, string> = {
  aarch64: "arm64",
  x86_64: "x64",
};

export function hostKey(
  denoOs: string = Deno.build.os,
  denoArch: string = Deno.build.arch,
): string {
  return `${OS_FROM_DENO[denoOs] ?? denoOs}-${
    ARCH_FROM_DENO[denoArch] ?? denoArch
  }`;
}

export function targetForHost(
  key: string,
  targets: Target[] = TARGETS,
): Target | null {
  const pkgKey = hostMap(targets)[key];
  return targets.find((t) => t.key === pkgKey) ?? null;
}
