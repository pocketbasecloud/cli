import {
  pb, testName, scaffold, cleanupOrphans,
  assertExitOk, assertJson,
} from "../setup.ts";
import { assert, assertStringIncludes } from "@std/assert";

const ENV: Record<string, string> = {};
const COMPUTE = "zzbtp4ke5fm3qow";

let projectId: string;

async function isPro(): Promise<boolean> {
  const r = await pb(["cloud", "whoami", "--json"], { env: ENV });
  return r.json?.plan === "pro";
}

Deno.test({
  name: "e2e: be deploy — cleanup orphans",
  fn: async () => { await cleanupOrphans(); },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: be deploy — full suite",
  fn: async (t) => {
    // Plan-gate: return early if not Pro (ignore is static in Deno).
    if (!await isPro()) {
      console.log("Skipping backend e2e tests — not a Pro account.");
      return;
    }

    // Create test project
    const proj = await pb(
      ["cloud", "project", "create", testName("be-project"), "--json"],
      { env: ENV },
    );
    assertExitOk(proj);
    assertJson(proj);
    projectId = proj.json!.id as string;

    await t.step("deploy deno backend", async () => {
      const name = testName("deno-be");
      const dir = scaffold({
        "deno.json": JSON.stringify({ tasks: { start: "deno run -A main.ts" } }),
        "main.ts": `Deno.serve(() => new Response("e2e backend"));`,
      });
      const r = await pb([
        "cloud", "backend", "deploy", "--compute", COMPUTE, "--name", name,
        "--runtime", "deno", "--start", "deno run -A main.ts", "--skip-build",
        "--project", projectId, "--json",
      ], { env: ENV, cwd: dir, timeout: 240_000 });
      assertExitOk(r);
      assertJson(r);
      const id = r.json!.id as string;
      assert(r.json!.status === "running", `Expected running, got ${r.json!.status}`);
      await pb(
        ["cloud", "backend", "rm", "--id", id, "--yes", "--project", projectId],
        { env: ENV, timeout: 30_000 },
      );
    });

    await t.step("missing --runtime fails with clear error", async () => {
      // Scaffold a directory without any runtime framework signals so the
      // CLI doesn't infer one from the project files.
      const dir = scaffold({ "main.ts": "// no deno.json so runtime is not inferred" });
      const r = await pb([
        "cloud", "backend", "deploy", "--compute", COMPUTE,
        "--name", testName("no-rt"), "--skip-build", "--project", projectId,
      ], { env: ENV, cwd: dir, timeout: 30_000 });
      assert(r.code !== 0, "Should fail without --runtime");
      assertStringIncludes(r.stderr, "runtime");
    });

    await t.step("missing --start fails with clear error", async () => {
      const dir = scaffold({ "deno.json": "{}" });
      const r = await pb([
        "cloud", "backend", "deploy", "--compute", COMPUTE,
        "--name", testName("no-start"), "--runtime", "deno",
        "--skip-build", "--project", projectId,
      ], { env: ENV, cwd: dir, timeout: 30_000 });
      assert(r.code !== 0, "Should fail without --start");
      assertStringIncludes(r.stderr, "start");
    });

    // Cleanup
    if (projectId) {
      await pb(
        ["cloud", "project", "rm", projectId, "--yes"],
        { env: ENV, timeout: 30_000 },
      );
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
