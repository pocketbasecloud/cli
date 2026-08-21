import { assertEquals } from "@std/assert";
import { activeProfileName, hostnameOf } from "../../src/resolve/profile.ts";
import { defaultConfig } from "../../src/config.ts";

Deno.test("hostnameOf extracts host", () => {
  assertEquals(hostnameOf("https://db.example.com/"), "db.example.com");
});

Deno.test("activeProfileName prefers flag then env then default", () => {
  const c = { ...defaultConfig(), defaultProfile: "def" };
  assertEquals(activeProfileName(c, "flagp", { PBC_PROFILE: "envp" }), "flagp");
  assertEquals(
    activeProfileName(c, undefined, { PBC_PROFILE: "envp" }),
    "envp",
  );
  assertEquals(activeProfileName(c, undefined, {}), "def");
  assertEquals(activeProfileName(defaultConfig(), undefined, {}), null);
});

Deno.test("a pre-0.6.0 PB_PROFILE still selects the profile", () => {
  const c = { ...defaultConfig(), defaultProfile: "saved" };
  assertEquals(activeProfileName(c, undefined, { PB_PROFILE: "old" }), "old");
  assertEquals(
    activeProfileName(c, undefined, { PB_PROFILE: "old", PBC_PROFILE: "new" }),
    "new",
  );
});

Deno.test("an empty PB_PROFILE falls through to the saved default", () => {
  // Empty means unset for every one of the CLI's variables, so an exported but
  // empty PB_PROFILE must not shadow the profile the user actually chose.
  const c = { ...defaultConfig(), defaultProfile: "saved" };
  assertEquals(activeProfileName(c, undefined, { PB_PROFILE: "" }), "saved");
  assertEquals(activeProfileName(c, undefined, { PBC_PROFILE: "" }), "saved");
});
