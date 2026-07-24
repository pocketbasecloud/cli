import { CliError } from "../errors.ts";

const RELEASES_PAGE = "https://github.com/pocketbase/pocketbase/releases";

/** Release asset operating systems. */
const OSES = ["darwin", "linux", "windows"] as const;

/**
 * Release asset architectures. Deno only ever reports x86_64 or aarch64, so
 * armv7/ppc64le/s390x are reachable only through an explicit --arch.
 */
const ARCHES = ["amd64", "arm64", "armv7", "ppc64le", "s390x"] as const;

const ARCH_FROM_HOST: Record<string, string> = {
  x86_64: "amd64",
  aarch64: "arm64",
};

export type Platform = {
  os: string;
  arch: string;
  assetName: (version: string) => string;
  binName: string;
};

export type DetectOpts = {
  os?: string;
  arch?: string;
  hostOs?: string;
  hostArch?: string;
};

export function detectPlatform(opts: DetectOpts = {}): Platform {
  const hostOs = opts.hostOs ?? Deno.build.os;
  const hostArch = opts.hostArch ?? Deno.build.arch;

  const os = opts.os ?? hostOs;
  if (!(OSES as readonly string[]).includes(os)) {
    throw new CliError(
      `PocketBase has no release build for "${os}". ` +
        `Supported: ${OSES.join(", ")}. See ${RELEASES_PAGE}.`,
      2,
    );
  }

  const arch = opts.arch ?? ARCH_FROM_HOST[hostArch];
  if (!arch || !(ARCHES as readonly string[]).includes(arch)) {
    throw new CliError(
      `PocketBase has no release build for "${opts.arch ?? hostArch}". ` +
        `Supported: ${ARCHES.join(", ")}. See ${RELEASES_PAGE}.`,
      2,
    );
  }

  return {
    os,
    arch,
    assetName: (version: string) => `pocketbase_${version}_${os}_${arch}.zip`,
    binName: os === "windows" ? "pocketbase.exe" : "pocketbase",
  };
}
