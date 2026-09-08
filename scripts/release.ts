import { dirname, fromFileUrl, join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { VERSION } from "../src/version.ts";
import { assetName, hostKey, hostMap, TARGETS } from "./targets.ts";

export const CLI_DIR = dirname(dirname(fromFileUrl(import.meta.url)));
export const DIST_DIR = join(CLI_DIR, "dist");
// npm/ stays ignored build scratch for compiled binaries. Releases ship only
// GitHub assets installed via scripts/install.sh; npm publishing is deprecated.
const BUILD_DIR = join(CLI_DIR, "npm");

const buildOnly = Deno.args.includes("--build-only");

function log(step: string) {
  console.log(`\n=== ${step} ===`);
}

async function sh(cmd: string[], cwd = CLI_DIR): Promise<void> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
}

async function ok(cmd: string[]): Promise<boolean> {
  try {
    const { code } = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "null",
      stderr: "null",
    }).output();
    return code === 0;
  } catch {
    return false;
  }
}

export async function checkPrereqs() {
  if (!(await ok(["gh", "auth", "status"]))) {
    throw new Error("gh: not authenticated. Run `gh auth login`.");
  }
}

export async function gate() {
  log("1. test / check / lint");
  await sh(["deno", "task", "test"]);
  await sh(["deno", "task", "check"]);
  await sh(["deno", "task", "lint"]);
}

export async function compileTargets() {
  log("2. compile targets");
  await Deno.remove(BUILD_DIR, { recursive: true }).catch(() => {});
  for (const t of TARGETS) {
    const outDir = join(BUILD_DIR, t.key, "bin");
    await Deno.mkdir(outDir, { recursive: true });
    const out = join(outDir, t.binName);
    console.log(`  ${t.key} -> ${t.denoTarget}`);
    await sh([
      "deno",
      "compile",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--target",
      t.denoTarget,
      "--output",
      out,
      "main.ts",
    ]);
    if (t.os !== "win32") await Deno.chmod(out, 0o755);
  }
}

async function selfVerifyBinary() {
  log("3. self-verify compiled binary");
  const suffix = hostMap(TARGETS)[hostKey()];
  if (!suffix) throw new Error(`no built binary for host ${hostKey()}`);
  const target = TARGETS.find((t) => t.key === suffix);
  if (!target) throw new Error(`no target for host ${hostKey()}`);
  const bin = join(BUILD_DIR, suffix, "bin", target.binName);
  const { code, stdout } = await new Deno.Command(bin, {
    args: ["--version"],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  const out = new TextDecoder().decode(stdout).trim();
  if (code !== 0 || out !== `pbc ${VERSION}`) {
    throw new Error(`binary self-verify failed: got "${out}" (code ${code})`);
  }
  console.log(`  binary printed "${out}" ✓`);
}

async function sha256(path: string): Promise<string> {
  const buf = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return encodeHex(new Uint8Array(digest));
}

async function buildArchives() {
  log("4. build dist/ archives + checksums.txt");
  await Deno.remove(DIST_DIR, { recursive: true }).catch(() => {});
  await Deno.mkdir(DIST_DIR, { recursive: true });
  const lines: string[] = [];
  for (const t of TARGETS) {
    const name = assetName(t, VERSION);
    const binDir = join(BUILD_DIR, t.key, "bin");
    if (t.os === "win32") {
      await sh(["zip", "-j", join(DIST_DIR, name), join(binDir, t.binName)]);
    } else {
      await sh(["tar", "-czf", join(DIST_DIR, name), "-C", binDir, t.binName]);
    }
    lines.push(`${await sha256(join(DIST_DIR, name))}  ${name}`);
  }
  await Deno.writeTextFile(
    join(DIST_DIR, "checksums.txt"),
    lines.join("\n") + "\n",
  );
}

export async function stageArtifacts(opts: { gate: boolean }) {
  if (opts.gate) await gate();
  await compileTargets();
  await selfVerifyBinary();
  await buildArchives();
}

function printNextSteps() {
  log("5. next steps");
  console.log(
    `  dist/ is staged for v${VERSION}. To publish:\n` +
      `    deno task cut-release ${VERSION} --notes "<release notes>"\n` +
      "  or follow the manual steps in docs/cli-public-repo-sync.md.\n" +
      "  npm publishing is deprecated and intentionally has no step here.",
  );
}

if (import.meta.main) {
  if (buildOnly) {
    await compileTargets();
    log(`build-only: staged binaries for v${VERSION}. Stop.`);
    Deno.exit(0);
  }
  if (Deno.args.includes("--stage-only")) {
    await stageArtifacts({ gate: true });
    Deno.exit(0);
  }
  await checkPrereqs();
  await stageArtifacts({ gate: true });
  printNextSteps();
}
