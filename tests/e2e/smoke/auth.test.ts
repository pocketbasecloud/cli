import {
  pb, assertExitOk, assertJson, assertExit, assertStderrContains,
} from "../setup.ts";
import { assert } from "@std/assert";

Deno.test({
  name: "e2e: auth — whoami with valid config-stored login",
  fn: async () => {
    const r = await pb(["cloud", "whoami", "--json"], { env: { PBC_TOKEN: "" } });
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
  name: "e2e: auth — whoami with invalid PBC_TOKEN",
  fn: async () => {
    const r = await pb(["cloud", "whoami"], {
      env: { PBC_TOKEN: "not-a-real-token" },
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
        env: { PBC_TOKEN: "", XDG_CONFIG_HOME: tmp },
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
  name: "e2e: auth — whoami --json on auth error produces a valid failure envelope",
  fn: async () => {
    const r = await pb(["cloud", "whoami", "--json"], {
      env: { PBC_TOKEN: "not-a-real-token" },
    });
    assertExit(4, r);
    assert(r.envelope?.ok === false, "expected an {ok: false} envelope on stdout");
    assert(r.error !== undefined, "expected r.error to be set");
    assert(r.error!.code === "NOT_AUTHENTICATED", `unexpected code: ${r.error!.code}`);
    assert(typeof r.error!.message === "string" && r.error!.message.length > 0);
    assert(typeof r.error!.hint === "string" && r.error!.hint.length > 0);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
