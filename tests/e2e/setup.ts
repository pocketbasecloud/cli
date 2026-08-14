import { assert, assertEquals } from "@std/assert";
import type { ResourceKind } from "../../src/clients/types.ts";

// ===================================================================
// Types
// ===================================================================

export type PbResult = {
  code: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
};

export type PbOpts = {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
};

// ===================================================================
// CLI runner
// ===================================================================

/** Resolved at import time — tests/e2e/ → tests/ → cli root. */
const CLI_ROOT = new URL("../..", import.meta.url).pathname;
const MAIN = `${CLI_ROOT}main.ts`;

export async function pb(args: string[], opts: PbOpts = {}): Promise<PbResult> {
  const allArgs = [...args, "--no-input"];
  const parentEnv = Deno.env.toObject();
  // Apply overrides; an explicit "" unsets the key entirely so the child
  // process sees no value for it (falsy in resolveCloudAuth).
  const childEnv = { ...parentEnv, ...opts.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === "") delete childEnv[k];
  }
  // Run from the target directory (opts.cwd) so deps.cwd() returns the
  // project dir. main.ts is referenced by absolute path.
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", MAIN, ...allArgs],
    cwd: opts.cwd ?? CLI_ROOT,
    env: childEnv,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });
  const timeout = opts.timeout ?? 60_000;
  const child = cmd.spawn();
  const timer = setTimeout(() => {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }, timeout);
  const { code, stdout, stderr } = await child.output();
  clearTimeout(timer);
  const stdoutText = new TextDecoder().decode(stdout);
  const stderrText = new TextDecoder().decode(stderr);
  const result: PbResult = { code, stdout: stdoutText, stderr: stderrText };
  if (allArgs.includes("--json") && stdoutText.trim()) {
    try {
      result.json = JSON.parse(stdoutText.trim().split("\n").pop()!);
    } catch { /* not JSON — caller inspects stdout */ }
  }
  return result;
}

// ===================================================================
// Unique names
// ===================================================================

let _counter = 0;
export function testName(base: string): string {
  _counter++;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `e2e-${base}-${ts}-${_counter}`;
}

// ===================================================================
// Temp directories
// ===================================================================

export function scaffold(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync({ prefix: "pb-e2e-" });
  for (const [path, body] of Object.entries(files)) {
    const full = `${root}/${path}`;
    Deno.mkdirSync(full.substring(0, full.lastIndexOf("/")), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

// ===================================================================
// Auth
// ===================================================================

export function requireToken(): string {
  const token = Deno.env.get("PB_TOKEN");
  if (!token) throw new Error("PB_TOKEN is not set — cannot run e2e tests");
  return token;
}

// ===================================================================
// Cleanup
// ===================================================================

type CleanupEntry = { kind: ResourceKind; id: string; projectId: string };

const _cleanup: CleanupEntry[] = [];

export function trackCleanup(kind: ResourceKind, id: string, projectId: string): void {
  _cleanup.push({ kind, id, projectId });
}

export async function runCleanup(): Promise<void> {
  const token = Deno.env.get("PB_TOKEN");
  if (!token) return;
  for (let i = _cleanup.length - 1; i >= 0; i--) {
    const { kind, id, projectId } = _cleanup[i];
    try {
      const cmdKind =
        kind === "pocketbases" ? "pb" : kind === "backends" ? "backend" : "frontend";
      await pb(["cloud", cmdKind, "rm", "--id", id, "--project", projectId, "--yes"], {
        env: { PB_TOKEN: token },
        timeout: 30_000,
      });
    } catch { /* already gone */ }
  }
  _cleanup.length = 0;
}

/**
 * Delete any e2e-* resources and projects left over from a crashed run.
 * Runs once at the start of each deploy test file so the suite always
 * begins from a clean slate — no manual cleanup required.
 */
export async function cleanupOrphans(): Promise<void> {
  const token = Deno.env.get("PB_TOKEN");
  if (!token) return;

  // Find e2e projects
  const proj = await pb(["cloud", "project", "ls", "--json"], {
    env: { PB_TOKEN: token },
    timeout: 15_000,
  });
  if (!proj.json) return;
  const projects = proj.json as unknown as { id: string; name: string }[];
  const e2eProjects = projects.filter((p) => p.name.startsWith("e2e-"));
  if (e2eProjects.length === 0) return;

  console.error(
    `Cleaning up ${e2eProjects.length} leftover e2e project(s) from a previous run…`,
  );

  for (const p of e2eProjects) {
    // Delete resources inside the project first, then the project
    for (const kind of ["pocketbases", "frontends", "backends"] as const) {
      const cmdKind = kind === "pocketbases" ? "pb" : kind === "backends" ? "backend" : "frontend";
      try {
        const list = await pb(
          ["cloud", cmdKind, "ls", "--project", p.id, "--json"],
          { env: { PB_TOKEN: token }, timeout: 15_000 },
        );
        if (!list.json) continue;
        const resources = list.json as unknown as { id: string; name: string }[];
        for (const r of resources) {
          if (!r.name.startsWith("e2e-")) continue;
          console.error(`  Deleting ${kind} ${r.name}…`);
          await pb(
            ["cloud", cmdKind, "rm", "--id", r.id, "--project", p.id, "--yes"],
            { env: { PB_TOKEN: token }, timeout: 30_000 },
          );
        }
      } catch { /* continue */ }
    }
    // Delete the project itself
    console.error(`  Deleting project ${p.name}…`);
    try {
      await pb(["cloud", "project", "rm", p.id, "--yes"], {
        env: { PB_TOKEN: token },
        timeout: 30_000,
      });
    } catch { /* already gone */ }
  }
}

// ===================================================================
// Assert helpers
// ===================================================================

export function assertExitOk(r: PbResult): void {
  assertEquals(
    r.code,
    0,
    `Expected exit 0, got ${r.code}\nstdout: ${r.stdout.slice(0, 500)}\nstderr: ${r.stderr.slice(0, 500)}`,
  );
}

export function assertJson(
  r: PbResult,
): asserts r is PbResult & { json: Record<string, unknown> } {
  assert(
    r.json != null,
    `Expected JSON output, got: ${r.stdout.slice(0, 200)}`,
  );
}

export function assertExit(code: number, r: PbResult): void {
  assertEquals(
    r.code,
    code,
    `Expected exit ${code}, got ${r.code}\nstdout: ${r.stdout.slice(0, 500)}\nstderr: ${r.stderr.slice(0, 500)}`,
  );
}

export function assertStderrContains(needle: string, r: PbResult): void {
  assert(
    r.stderr.includes(needle),
    `Expected stderr to contain "${needle}", got: ${r.stderr.slice(0, 500)}`,
  );
}
