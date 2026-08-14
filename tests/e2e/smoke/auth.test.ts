import {
  pb, assertExitOk, assertJson, assertExit, assertStderrContains,
} from "../setup.ts";
import { assert } from "@std/assert";

// Auth tests. "Valid token" means the config file has a stored login —
// empty PB_TOKEN lets the CLI fall back to it. "Invalid token" is an
// explicit PB_TOKEN that the backend rejects. "Missing auth" means
// no env token AND no config file (redirected XDG_CONFIG_HOME).

Deno.test({
  name: "e2e: auth — whoami with valid config-stored login",
  fn: async () => {
    // Clear env token so the CLI falls back to config file.
    const r = await pb(["cloud", "whoami", "--json"], { env: { PB_TOKEN: "" } });
    assertExitOk(r);
    assertJson(r);
    assert(typeof r.json!.id === "string", "whoami should have an id");
    assert(typeof r.json!.email === "string", "whoami should have an email");
    assert(typeof r.json!.plan === "string", "whoami should have a plan");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: auth — whoami with invalid PB_TOKEN",
  fn: async () => {
    const r = await pb(["cloud", "whoami"], {
      env: { PB_TOKEN: "not-a-real-token" },
    });
    assertExit(4, r);
    assertStderrContains("Not authenticated", r);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: auth — whoami fails when neither token nor config is present",
  fn: async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "pb-e2e-config-" });
    try {
      const r = await pb(["cloud", "whoami"], {
        env: { PB_TOKEN: "", XDG_CONFIG_HOME: tmp },
      });
      assertExit(4, r);
      assertStderrContains("Not logged in", r);
    } finally {
      try { Deno.removeSync(tmp, { recursive: true }); } catch { /* ok */ }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "e2e: auth — whoami --json on auth error produces valid JSON",
  fn: async () => {
    const r = await pb(["cloud", "whoami", "--json"], {
      env: { PB_TOKEN: "not-a-real-token" },
    });
    assertExit(4, r);
    const parsed = JSON.parse(r.stderr.trim().split("\n").pop()!);
    assert(typeof parsed.error === "string", "auth error JSON should have 'error' key");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
