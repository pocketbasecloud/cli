import { globToRegExp, join } from "@std/path";
import { CliError } from "../errors.ts";
import { type BuildConfig, linkFileName } from "../config.ts";
import type { ResourceKind } from "../clients/types.ts";
import { writeZip, type ZipEntry } from "./zip.ts";
import {
  describeStandaloneResult,
  ensureStandaloneOutput,
} from "./next-config.ts";
import { describeInstall, planInstall } from "./install.ts";
import { plainProgress, type Progress } from "../ui/progress.ts";

const DENY_SEGMENTS = [".git", "pb_data", ".DS_Store"];
const DENY_FILES = [".env", ".env.*", "*.log"];

export type Strategy = "static" | "source" | "standalone" | "pbdirs";

export type PackageResult = {
  bytes: Uint8Array;
  fileName: string;
  fileCount: number;
  startCommand?: string;
};

export type CommandRunner = (
  command: string,
  cwd: string,
) => Promise<{ code: number }>;

export const runShell: CommandRunner = async (command, cwd) => {
  const [exe, flag] = Deno.build.os === "windows"
    ? ["cmd", "/c"]
    : ["/bin/sh", "-c"];
  const child = new Deno.Command(exe, {
    args: [flag, command],
    cwd,
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const forwarding = child.stdout.pipeTo(Deno.stderr.writable, {
    preventClose: true,
  });
  const { code } = await child.status;
  await forwarding;
  return { code };
};

export function strategyFor(
  kind: ResourceKind,
  runtime: string | undefined,
): Strategy {
  if (kind === "pocketbases") return "pbdirs";
  if (kind === "frontends") return "static";
  return runtime === "nextjs" ? "standalone" : "source";
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

function matchesAny(name: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(name));
}

async function collect(
  root: string,
  prefix: string,
  opts: { keepNodeModules: boolean; extra: RegExp[] },
): Promise<ZipEntry[]> {
  const denyFiles = DENY_FILES.map((g) => globToRegExp(g));
  const out: ZipEntry[] = [];
  const seen = new Set<string>();

  async function walk(dir: string, rel: string): Promise<void> {
    const real = await Deno.realPath(dir).catch(() => dir);
    if (seen.has(real)) return;
    seen.add(real);

    for await (const entry of Deno.readDir(dir)) {
      const name = entry.name;
      if (DENY_SEGMENTS.includes(name)) continue;
      if (name === "node_modules" && !opts.keepNodeModules) continue;

      const childRel = rel ? `${rel}/${name}` : name;
      const archiveName = prefix ? `${prefix}/${childRel}` : childRel;
      if (matchesAny(archiveName, opts.extra)) continue;

      const abs = join(dir, name);
      const stat = await Deno.stat(abs).catch(() => null);
      if (!stat) continue;

      if (stat.isDirectory) {
        await walk(abs, childRel);
        continue;
      }
      if (matchesAny(name, denyFiles)) continue;
      out.push({ name: archiveName, body: await Deno.readFile(abs) });
    }
  }

  await walk(root, "");
  return out;
}

function requireDir(path: string, hint: string): Promise<void> {
  return isDir(path).then((ok) => {
    if (!ok) throw new CliError(hint, { code: "USAGE" });
  });
}

function merge(groups: ZipEntry[][]): ZipEntry[] {
  const byName = new Map<string, ZipEntry>();
  for (const group of groups) {
    for (const e of group) byName.set(e.name, e);
  }
  return [...byName.values()];
}

async function packStandalone(
  cwd: string,
  extra: RegExp[],
): Promise<{ entries: ZipEntry[]; startCommand: string }> {
  const standalone = join(cwd, ".next", "standalone");
  await requireDir(
    standalone,
    `.next/standalone not found in ${cwd}. Next.js backends must be built ` +
      `with output: "standalone" in next.config.* — the platform does not ` +
      `build them (next build exhausts memory on a shared host). Deploying ` +
      `without --skip-build sets that up and builds it for you.`,
  );

  const opts = { keepNodeModules: true, extra };
  const groups = [await collect(standalone, "", opts)];

  const staticDir = join(cwd, ".next", "static");
  if (await isDir(staticDir)) {
    groups.push(await collect(staticDir, ".next/static", opts));
  }
  const publicDir = join(cwd, "public");
  if (await isDir(publicDir)) {
    groups.push(await collect(publicDir, "public", opts));
  }

  const entries = merge(groups);
  if (!entries.some((e) => e.name === "server.js")) {
    throw new CliError(
      `No server.js at the root of .next/standalone — the bundle cannot ` +
        `start. Check that next.config.* sets output: "standalone".`,
        { code: "USAGE" });
  }
  return { entries, startCommand: "node server.js" };
}

async function packPbDirs(
  cwd: string,
  build: BuildConfig,
  extra: RegExp[],
): Promise<ZipEntry[]> {
  const pairs: [string | undefined, string, string][] = [
    [build.pbPublic, "pb_public", "pbPublic"],
    [build.pbHooks, "pb_hooks", "pbHooks"],
    [build.pbMigrations, "pb_migrations", "pbMigrations"],
  ];
  const groups: ZipEntry[][] = [];
  const name = await linkFileName(cwd);
  for (const [src, canonical, field] of pairs) {
    if (!src) continue;
    const abs = join(cwd, src);
    await requireDir(
      abs,
      `${src} not found in ${cwd} (${name} build.${field}).`,
    );
    groups.push(
      await collect(abs, canonical, { keepNodeModules: false, extra }),
    );
  }
  return merge(groups);
}

export async function packageResource(opts: {
  cwd: string;
  kind: ResourceKind;
  build: BuildConfig;
  skipBuild: boolean;
  log: (msg: string) => void;
  progress?: Progress;
  run?: CommandRunner;
}): Promise<PackageResult> {
  const { cwd, kind, build, log } = opts;
  const progress = opts.progress ?? plainProgress(log);
  const strategy = strategyFor(kind, build.runtime);

  if (strategy === "standalone" && build.command && !opts.skipBuild) {
    const note = describeStandaloneResult(await ensureStandaloneOutput(cwd));
    if (note) log(note);
  }

  if (build.command && !opts.skipBuild) {
    const run = opts.run ?? runShell;
    const plan = build.install === ""
      ? null
      : await planInstall(cwd, build.install);
    if (plan) {
      await progress.step(describeInstall(plan), async (step) => {
        const { code } = await run(plan.command, plan.cwd);
        if (code !== 0) {
          throw new CliError(
            `Installing dependencies failed (${plan.command} exited ${code} ` +
              `in ${plan.cwd}). Install them yourself and deploy again, or ` +
              `set "install" in the build block of ${await linkFileName(
                plan.cwd,
              )} to the right command.`);
        }
        step.done(`Installed dependencies (${plan.command})`);
      }, { animate: false });
    }

    await progress.step(`Building: ${build.command}`, async (step) => {
      const { code } = await run(build.command as string, cwd);
      if (code !== 0) {
        throw new CliError(
          `Build failed (${build.command} exited ${code}).`);
      }
      step.done(`Built (${build.command})`);
    }, { animate: false });
  }

  const extra = (build.exclude ?? []).map((g) =>
    globToRegExp(g, { globstar: true })
  );

  return await progress.step("Packaging files", async (step) => {
    let entries: ZipEntry[];
    let startCommand: string | undefined;

    if (strategy === "standalone") {
      const packed = await packStandalone(cwd, extra);
      entries = packed.entries;
      startCommand = packed.startCommand;
    } else if (strategy === "pbdirs") {
      entries = await packPbDirs(cwd, build, extra);
    } else {
      const dir = build.outputDir ?? (strategy === "static" ? "dist" : ".");
      const abs = join(cwd, dir);
      const name = await linkFileName(cwd);
      await requireDir(
        abs,
        strategy === "static"
          ? `Build output ${dir} not found in ${cwd}. Set build.outputDir in ` +
            `${name}, or check that the build command produced it.`
          : `${dir} not found in ${cwd} (${name} build.outputDir).`,
      );
      entries = await collect(abs, "", { keepNodeModules: false, extra });
    }

    if (entries.length === 0 && strategy !== "pbdirs") {
      throw new CliError(
        `Nothing to deploy — the packaged zip is empty.`,
        { code: "USAGE" },
      );
    }

    step.update(`Compressing ${entries.length} file(s)`);
    const bytes = await writeZip(entries);
    step.done(
      `Packaged ${entries.length} file(s), ${formatSize(bytes.length)}.`,
    );
    return {
      bytes,
      fileName: fileNameFor(kind),
      fileCount: entries.length,
      startCommand,
    };
  });
}

function fileNameFor(kind: ResourceKind): string {
  return kind === "pocketbases" ? "data.zip" : "code.zip";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
