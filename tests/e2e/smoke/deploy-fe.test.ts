import {
  pb, testName, scaffold, cleanupOrphans,
  assertExitOk, assertJson,
} from "../setup.ts";
import { assert, assertStringIncludes } from "@std/assert";

const ENV: Record<string, string> = {};
const COMPUTE = "zzbtp4ke5fm3qow";

let projectId: string;

Deno.test({
  name: "e2e: fe deploy — cleanup orphans",
  fn: async () => { await cleanupOrphans(); },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: fe deploy — create test project",
  fn: async () => {
    const r = await pb(
      ["cloud", "project", "create", testName("fe-project"), "--json"],
      { env: ENV },
    );
    assertExitOk(r);
    assertJson(r);
    projectId = r.json!.id as string;
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: fe deploy — happy path",
  fn: async (t) => {
    await t.step("deploy static site", async () => {
      const name = testName("static");
      const dir = scaffold({
        "index.html": "<!doctype html><html><body>e2e frontend</body></html>",
      });
      const r = await pb([
        "cloud", "frontend", "deploy", "--compute", COMPUTE, "--name", name, "--skip-build",
        "--project", projectId, "--json",
      ], { env: ENV, cwd: dir, timeout: 180_000 });
      assertExitOk(r);
      assertJson(r);
      const id = r.json!.id as string;
      assert(r.json!.status === "running", `Expected running, got ${r.json!.status}`);
      assert(typeof r.json!.domain === "string", "Should have a domain");
      await pb(
        ["cloud", "frontend", "rm", "--id", id, "--yes", "--project", projectId],
        { env: ENV, timeout: 30_000 },
      );
    });

    await t.step("deploy with auto-detection (pbc deploy)", async () => {
      const name = testName("auto-fe");
      const dir = scaffold({
        "index.html": "<!doctype html><html><body>auto</body></html>",
      });
      const r = await pb([
        "cloud", "deploy", "--compute", COMPUTE, "--name", name, "--skip-build",
        "--project", projectId, "--json",
      ], { env: ENV, cwd: dir, timeout: 240_000 });
      assertExitOk(r);
      assertJson(r);
      const id = r.json!.id as string;
      await pb(
        ["cloud", "frontend", "rm", "--id", id, "--yes", "--project", projectId],
        { env: ENV, timeout: 30_000 },
      );
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: fe deploy — edge cases",
  fn: async (t) => {
    await t.step("empty directory fails detection", async () => {
      const dir = scaffold({});
      const r = await pb([
        "cloud", "deploy", "--project", projectId, "--json",
      ], { env: ENV, cwd: dir, timeout: 30_000 });
      assert(r.code !== 0, "Should fail on empty directory detection");
    });

    await t.step("wrong kind override fails with clear error", async () => {
      const dir = scaffold({ "index.html": "<!doctype html>" });
      const r = await pb([
        "cloud", "backend", "deploy", "--name", testName("wrong"),
        "--project", projectId,
      ], { env: ENV, cwd: dir, timeout: 30_000 });
      assert(r.code !== 0, "Should fail when deploying frontend dir as backend");
      assertStringIncludes(r.stderr, "runtime");
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: fe deploy — cleanup test project",
  fn: async () => {
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
