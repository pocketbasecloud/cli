import { assertEquals } from "@std/assert";
import { activeProfileName, hostnameOf } from "../../src/resolve/profile.ts";
import { defaultConfig } from "../../src/config.ts";

Deno.test("hostnameOf extracts host", () => {
  assertEquals(hostnameOf("https://db.example.com/"), "db.example.com");
});

Deno.test("activeProfileName prefers flag then env then default", () => {
  const c = { ...defaultConfig(), defaultProfile: "def" };
  assertEquals(activeProfileName(c, "flagp", { PB_PROFILE: "envp" }), "flagp");
  assertEquals(activeProfileName(c, undefined, { PB_PROFILE: "envp" }), "envp");
  assertEquals(activeProfileName(c, undefined, {}), "def");
  assertEquals(activeProfileName(defaultConfig(), undefined, {}), null);
});
