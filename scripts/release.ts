// Local release orchestrator. Never publishes — it stages everything and
// prints the exact commands to run. `--build-only` stops after staging npm/.
import { dirname, fromFileUrl, join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { VERSION } from "../src/version.ts";
import { assetName, hostMap, TARGETS } from "./targets.ts";
import {
  buildMainPackageJson,
  buildPlatformPackageJson,
  buildShim,
} from "./pkg.ts";

const CLI_DIR = dirname(dirname(fromFileUrl(import.meta.url))); // .../cli
const NPM_DIR = join(CLI_DIR, "npm");
const DIST_DIR = join(CLI_DIR, "dist");

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

// --- prerequisite checks (skipped for --build-only) -----------------------
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

async function checkPrereqs() {
  if (!(await ok(["npm", "whoami"]))) {
    throw new Error(
      "npm: not logged in. Run `npm login` for an account that can publish to @pocketbasecloud.",
    );
  }
  if (!(await ok(["gh", "auth", "status"]))) {
    throw new Error("gh: not authenticated. Run `gh auth login`.");
  }
}

// --- steps ----------------------------------------------------------------
async function gate() {
  log("1. test / check / lint");
  await sh(["deno", "task", "test"]);
  await sh(["deno", "task", "check"]);
  await sh(["deno", "task", "lint"]);
}

async function compileTargets() {
  log("2. compile five targets");
  await Deno.remove(NPM_DIR, { recursive: true }).catch(() => {});
  for (const t of TARGETS) {
    const outDir = join(NPM_DIR, t.key, "bin");
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

async function stagePackages() {
  log("3. stage six package.json files + shim + README");
  for (const t of TARGETS) {
    const pkg = buildPlatformPackageJson(t, VERSION);
    await Deno.writeTextFile(
      join(NPM_DIR, t.key, "package.json"),
      JSON.stringify(pkg, null, 2) + "\n",
    );
  }
  const mainDir = join(NPM_DIR, "cli");
  await Deno.mkdir(join(mainDir, "bin"), { recursive: true });
  await Deno.writeTextFile(
    join(mainDir, "package.json"),
    JSON.stringify(buildMainPackageJson(VERSION), null, 2) + "\n",
  );
  await Deno.writeTextFile(join(mainDir, "bin", "pb.js"), buildShim(TARGETS));
  await Deno.chmod(join(mainDir, "bin", "pb.js"), 0o755);
  await Deno.copyFile(
    join(CLI_DIR, "README.md"),
    join(mainDir, "README.md"),
  );
}

async function packSizes() {
  log("4. npm pack --dry-run size table");
  for (const t of TARGETS) {
    await sh(["npm", "pack", "--dry-run", join(NPM_DIR, t.key)], NPM_DIR);
  }
  await sh(["npm", "pack", "--dry-run", join(NPM_DIR, "cli")], NPM_DIR);
}

function hostKey(): string {
  const osMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    windows: "win32",
  };
  const archMap: Record<string, string> = { aarch64: "arm64", x86_64: "x64" };
  const os = osMap[Deno.build.os] ?? Deno.build.os;
  const arch = archMap[Deno.build.arch] ?? Deno.build.arch;
  return `${os}-${arch}`;
}

async function selfVerifyShim() {
  log("5. self-verify shim by executing it");
  const suffix = hostMap(TARGETS)[hostKey()];
  if (!suffix) throw new Error(`no built package for host ${hostKey()}`);
  const linkRoot = join(NPM_DIR, "cli", "node_modules", "@pocketbasecloud");
  await Deno.mkdir(linkRoot, { recursive: true });
  const link = join(linkRoot, `cli-${suffix}`);
  await Deno.remove(link).catch(() => {});
  await Deno.symlink(join(NPM_DIR, suffix), link);
  const { code, stdout } = await new Deno.Command("node", {
    args: [join(NPM_DIR, "cli", "bin", "pb.js"), "--version"],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  const out = new TextDecoder().decode(stdout).trim();
  if (code !== 0 || out !== `pb ${VERSION}`) {
    throw new Error(`shim self-verify failed: got "${out}" (code ${code})`);
  }
  console.log(`  shim printed "${out}" ✓`);
}

async function sha256(path: string): Promise<string> {
  const buf = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return encodeHex(new Uint8Array(digest));
}

async function buildArchives() {
  log("6. build dist/ archives + checksums.txt");
  await Deno.remove(DIST_DIR, { recursive: true }).catch(() => {});
  await Deno.mkdir(DIST_DIR, { recursive: true });
  const lines: string[] = [];
  for (const t of TARGETS) {
    const name = assetName(t, VERSION);
    const binDir = join(NPM_DIR, t.key, "bin");
    if (t.os === "win32") {
      // `zip -j` flattens paths so the archive holds pb.exe at its root.
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

function printPublishCommands() {
  log("7. publish commands (run these yourself, in this order)");
  for (const t of TARGETS) {
    console.log(`npm publish npm/${t.key} --access public`);
  }
  console.log(`npm publish npm/cli --access public   # last`);
  console.log(
    `\ngh release create v${VERSION} --repo pocketbasecloud/cli \\\n` +
      `  --title "pb v${VERSION}" dist/*`,
  );
}

// --- main -----------------------------------------------------------------
if (import.meta.main) {
  // `deno task build` (--build-only) is a fast compile; the test/check/lint
  // gate is part of the full `release` flow only.
  if (!buildOnly) await gate();
  await compileTargets();
  await stagePackages();
  if (buildOnly) {
    log(`build-only: staged npm/ for v${VERSION}. Stop.`);
    Deno.exit(0);
  }
  await checkPrereqs();
  await packSizes();
  await selfVerifyShim();
  await buildArchives();
  printPublishCommands();
}
