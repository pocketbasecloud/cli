import { assert, assertEquals } from "@std/assert";
import type { ResourceKind } from "../../src/clients/types.ts";

export type PbError = {
  code: string;
  message: string;
  hint: string;
  docs?: string;
  retryable: boolean;
};

export type PbEnvelope = {
  ok: boolean;
  schemaVersion: number;
  data?: Record<string, unknown>;
  error?: PbError;
};

export type PbResult = {
  code: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
  envelope?: PbEnvelope;
  error?: PbError;
};

export type PbOpts = {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
};

const CLI_ROOT = new URL("../..", import.meta.url).pathname;
const MAIN = `${CLI_ROOT}main.ts`;

export async function pb(args: string[], opts: PbOpts = {}): Promise<PbResult> {
  const allArgs = [...args, "--no-input"];
  const parentEnv = Deno.env.toObject();
  const childEnv = { ...parentEnv, ...opts.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v !== "") continue;
    delete childEnv[k];
    if (k.startsWith("PBC_")) delete childEnv[`PB_${k.slice("PBC_".length)}`];
  }
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
      const parsed = JSON.parse(stdoutText.trim()) as PbEnvelope;
      result.envelope = parsed;
      if (parsed.ok) {
        result.json = parsed.data;
      } else {
        result.error = parsed.error;
      }
    } catch { /* not one JSON object — a stream, or not JSON. Caller inspects stdout. */ }
  }
  return result;
}

let _counter = 0;
export function testName(base: string): string {
  _counter++;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `e2e-${base}-${ts}-${_counter}`;
}

export function scaffold(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync({ prefix: "pb-e2e-" });
  for (const [path, body] of Object.entries(files)) {
    const full = `${root}/${path}`;
    Deno.mkdirSync(full.substring(0, full.lastIndexOf("/")), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

export function requireToken(): string {
  const token = Deno.env.get("PBC_TOKEN");
  if (!token) throw new Error("PBC_TOKEN is not set — cannot run e2e tests");
  return token;
}

type CleanupEntry = { kind: ResourceKind; id: string; projectId: string };

const _cleanup: CleanupEntry[] = [];

export function trackCleanup(kind: ResourceKind, id: string, projectId: string): void {
  _cleanup.push({ kind, id, projectId });
}

export async function runCleanup(): Promise<void> {
  const token = Deno.env.get("PBC_TOKEN");
  if (!token) return;
  for (let i = _cleanup.length - 1; i >= 0; i--) {
    const { kind, id, projectId } = _cleanup[i];
    try {
      const cmdKind =
        kind === "pocketbases" ? "pb" : kind === "backends" ? "backend" : "frontend";
      await pb(["cloud", cmdKind, "rm", "--id", id, "--project", projectId, "--yes"], {
        env: { PBC_TOKEN: token },
        timeout: 30_000,
      });
    } catch { /* already gone */ }
  }
  _cleanup.length = 0;
}

export async function cleanupOrphans(): Promise<void> {
  const token = Deno.env.get("PBC_TOKEN");
  if (!token) return;

  const proj = await pb(["cloud", "project", "ls", "--json"], {
    env: { PBC_TOKEN: token },
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
    for (const kind of ["pocketbases", "frontends", "backends"] as const) {
      const cmdKind = kind === "pocketbases" ? "pb" : kind === "backends" ? "backend" : "frontend";
      try {
        const list = await pb(
          ["cloud", cmdKind, "ls", "--project", p.id, "--json"],
          { env: { PBC_TOKEN: token }, timeout: 15_000 },
        );
        if (!list.json) continue;
        const resources = list.json as unknown as { id: string; name: string }[];
        for (const r of resources) {
          if (!r.name.startsWith("e2e-")) continue;
          console.error(`  Deleting ${kind} ${r.name}…`);
          await pb(
            ["cloud", cmdKind, "rm", "--id", r.id, "--project", p.id, "--yes"],
            { env: { PBC_TOKEN: token }, timeout: 30_000 },
          );
        }
      } catch { /* continue */ }
    }
    console.error(`  Deleting project ${p.name}…`);
    try {
      await pb(["cloud", "project", "rm", p.id, "--yes"], {
        env: { PBC_TOKEN: token },
        timeout: 30_000,
      });
    } catch { /* already gone */ }
  }
}

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
