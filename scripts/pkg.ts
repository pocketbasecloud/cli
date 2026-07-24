import { hostMap, type Target, TARGETS } from "./targets.ts";

export function buildPlatformPackageJson(
  target: Target,
  version: string,
): Record<string, unknown> {
  return {
    name: `@pocketbasecloud/cli-${target.key}`,
    version,
    description: `${target.key} binary for @pocketbasecloud/cli.`,
    license: "MIT",
    os: [target.os],
    cpu: target.cpu,
    files: ["bin"],
    engines: { node: ">=18" },
  };
}

export function buildMainPackageJson(version: string): Record<string, unknown> {
  const optionalDependencies: Record<string, string> = {};
  for (const t of TARGETS) {
    // Exact pin — a caret range would let npm pair a new shim with an older
    // binary after a partial publish.
    optionalDependencies[`@pocketbasecloud/cli-${t.key}`] = version;
  }
  return {
    name: "@pocketbasecloud/cli",
    version,
    description: "CLI for PocketBase Cloud and local PocketBase development.",
    license: "MIT",
    bin: { pb: "bin/pb.js" },
    files: ["bin", "README.md"],
    engines: { node: ">=18" },
    optionalDependencies,
  };
}

export function buildShim(targets: Target[]): string {
  const map = hostMap(targets);
  const entries = Object.entries(map)
    .map(([host, key]) => `  ${JSON.stringify(host)}: ${JSON.stringify(key)},`)
    .join("\n");
  return `#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");

// GENERATED from scripts/targets.ts — do not edit by hand.
// Maps a host \`\${process.platform}-\${process.arch}\` to the package that
// serves it. Note win32-arm64 maps to the x64 package, which it runs under
// emulation; the key and the package name are NOT always equal.
const PACKAGE_FOR_HOST = {
${entries}
};

const host = \`\${process.platform}-\${process.arch}\`;
const suffix = PACKAGE_FOR_HOST[host];
const exe = process.platform === "win32" ? "pb.exe" : "pb";

let bin;
try {
  if (!suffix) throw new Error("unsupported host");
  bin = require.resolve(\`@pocketbasecloud/cli-\${suffix}/bin/\${exe}\`);
} catch {
  console.error(
    \`pb: no prebuilt binary for \${host}.\\n\\n\` +
      \`Supported platforms: \${Object.keys(PACKAGE_FOR_HOST).join(", ")}.\\n\` +
      \`If your platform is listed, the optional dependency was skipped — \` +
      \`reinstall without --no-optional / --ignore-optional.\\n\` +
      \`Otherwise run from source with Deno: \` +
      \`deno install -A -n pb <repo>/cli/main.ts\`,
  );
  process.exit(1);
}

const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (r.error) {
  console.error(\`pb: failed to run \${bin}: \${r.error.message}\`);
  process.exit(1);
}
// Re-raise a fatal signal so Ctrl-C behaves like the binary was run directly.
if (r.signal) {
  process.kill(process.pid, r.signal);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
`;
}
