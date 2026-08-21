import {
  pb, testName, scaffold, trackCleanup, cleanupOrphans,
  assertExitOk, assertJson,
} from "../setup.ts";
import { assert, assertStringIncludes } from "@std/assert";

// Use config-file auth (no PBC_TOKEN) so tests work with any logged-in account.
const ENV: Record<string, string> = {};
// Pro accounts with multiple computes need an explicit --compute on deploy.
// Picked from the test account's deploy-context; stable as long as computes
// aren't added or removed. From `chooseCompute()` in deploy-helper.ts.
const COMPUTE = "zzbtp4ke5fm3qow";

let projectId: string;

Deno.test({
  name: "e2e: pb deploy — cleanup orphans from previous run",
  fn: async () => { await cleanupOrphans(); },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: pb deploy — create test project",
  fn: async () => {
    const r = await pb(
      ["cloud", "project", "create", testName("project"), "--json"],
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
  name: "e2e: pb deploy — happy path",
  fn: async (t) => {
    await t.step("deploy minimal instance (pb_migrations only)", async () => {
      const name = testName("minimal");
      const dir = scaffold({
        "pb_migrations/1_init.js": "// e2e minimal migration",
      });
      const r = await pb([
        "cloud", "pb", "deploy", "--compute", COMPUTE, "--name", name, "--skip-build",
        "--project", projectId, "--json",
      ], { env: ENV, cwd: dir, timeout: 180_000 });
      assertExitOk(r);
      assertJson(r);
      const id = r.json!.id as string;
      assert(r.json!.status === "running", `Expected running, got ${r.json!.status}`);
      assert(typeof r.json!.baseUrl === "string", "Should have a baseUrl");
      assert(typeof r.json!.adminUsername === "string", "Should have adminUsername");
      // Clean up
      const rm = await pb(
        ["cloud", "pb", "rm", "--id", id, "--yes", "--project", projectId],
        { env: ENV, timeout: 30_000 },
      );
      assertExitOk(rm);
    });

    await t.step("deploy with pb_hooks", async () => {
      const name = testName("hooks");
      const dir = scaffold({
        "pb_hooks/main.pb.js":
          `// e2e smoke test\nonRecordAfterCreateSuccess((e) => { console.log("ok"); });`,
      });
      const r = await pb([
        "cloud", "pb", "deploy", "--compute", COMPUTE, "--name", name, "--skip-build",
        "--project", projectId, "--json",
      ], { env: ENV, cwd: dir, timeout: 180_000 });
      assertExitOk(r);
      assertJson(r);
      const id = r.json!.id as string;
      assert(r.json!.status === "running", `Expected running, got ${r.json!.status}`);
      await pb(
        ["cloud", "pb", "rm", "--id", id, "--yes", "--project", projectId],
        { env: ENV, timeout: 30_000 },
      );
    });

    await t.step("deploy with pb_public", async () => {
      const name = testName("public");
      const dir = scaffold({
        "pb_public/index.html": "<!doctype html><html><body>e2e</body></html>",
      });
      const r = await pb([
        "cloud", "pb", "deploy", "--compute", COMPUTE, "--name", name, "--skip-build",
        "--project", projectId, "--json",
      ], { env: ENV, cwd: dir, timeout: 180_000 });
      assertExitOk(r);
      assertJson(r);
      const id = r.json!.id as string;
      assert(r.json!.status === "running", `Expected running, got ${r.json!.status}`);
      await pb(
        ["cloud", "pb", "rm", "--id", id, "--yes", "--project", projectId],
        { env: ENV, timeout: 30_000 },
      );
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: pb deploy — edge cases",
  fn: async (t) => {
    await t.step("nested hook file is rejected before deploy", async () => {
      const name = testName("nested");
      const dir = scaffold({
        "pb_hooks/lib/helpers.js": "// nested — should be rejected",
      });
      const r = await pb([
        "cloud", "pb", "deploy", "--compute", COMPUTE, "--name", name, "--skip-build",
        "--project", projectId, "--json",
      ], { env: ENV, cwd: dir, timeout: 60_000 });
      assert(r.code !== 0, "Should fail on nested hook file");
      assertStringIncludes(r.stderr, "subdirectory");
    });

    await t.step("--name required when --no-input is set", async () => {
      const dir = scaffold({ "pb_hooks/main.pb.js": "//" });
      const r = await pb([
        "cloud", "pb", "deploy", "--compute", COMPUTE, "--skip-build", "--project", projectId,
      ], { env: ENV, cwd: dir, timeout: 30_000 });
      assert(r.code !== 0, "Should fail without --name under --no-input");
      assertStringIncludes(r.stderr, "name");
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: pb deploy — redeploy updates, no duplicate",
  fn: async () => {
    const name = testName("redeploy");
    const dir = scaffold({ "pb_hooks/main.pb.js": "// v1" });

    const r1 = await pb([
      "cloud", "pb", "deploy", "--compute", COMPUTE, "--name", name, "--skip-build",
      "--project", projectId, "--json",
    ], { env: ENV, cwd: dir, timeout: 180_000 });
    assertExitOk(r1);
    assertJson(r1);
    const id1 = r1.json!.id as string;
    trackCleanup("pocketbases", id1, projectId);

    // Edit and redeploy from same dir — pbc.json now binds it
    Deno.writeTextFileSync(`${dir}/pb_hooks/main.pb.js`, "// v2 — updated");

    const r2 = await pb([
      "cloud", "pb", "deploy", "--compute", COMPUTE, "--skip-build", "--project", projectId, "--json",
    ], { env: ENV, cwd: dir, timeout: 180_000 });
    assertExitOk(r2);
    assertJson(r2);
    assert(
      r2.json!.id === id1,
      `Redeploy should update same resource (${id1}), got ${r2.json!.id}`,
    );

    // Clean up
    await pb(
      ["cloud", "pb", "rm", id1, "--yes", "--project", projectId],
      { env: ENV, timeout: 30_000 },
    );
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: pb deploy — cleanup test project",
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
