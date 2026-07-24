import { assertEquals } from "@std/assert";
import { COMMANDS } from "../../src/usage.ts";
import { registerCommands } from "../../src/commands/index.ts";
import type { Handler } from "../../src/router.ts";

Deno.test("COMMANDS has exactly one entry per registered command, no orphans", () => {
  const registry: Record<string, Handler> = {};
  registerCommands(registry);
  assertEquals(Object.keys(COMMANDS).sort(), Object.keys(registry).sort());
});

Deno.test("a single-paragraph command's rendered text matches the original prose", () => {
  const spec = COMMANDS["cloud org share"];
  assertEquals(
    [spec.usage, spec.summary, spec.details].filter(Boolean).join("\n\n"),
    "pb cloud org share <project> (--org <id>|--none)\n\n" +
      "Share a project with an org, or unshare it with --none.",
  );
  assertEquals(spec.args, [{ name: "project", required: true }]);
  assertEquals(spec.flags, [
    { name: "org", type: "string", required: false },
    { name: "none", type: "boolean", required: false },
  ]);
});

Deno.test("a multi-paragraph command (auth) reconstructs identically to the original prose", () => {
  const spec = COMMANDS["auth"];
  const rebuilt = [spec.usage, spec.summary, spec.details].filter(Boolean)
    .join("\n\n");
  assertEquals(
    rebuilt,
    "pb auth <collection> config [--set '<field>=<json>']\n\n" +
      "View or edit an auth collection's auth-related settings.\n\n" +
      "Without --set, prints the current value of: authRule, manageRule, authAlert,\n" +
      "oauth2, passwordAuth, mfa, otp, verificationTemplate, resetPasswordTemplate.\n\n" +
      "With --set '<field>=<json>', replaces that one field's value entirely — run\n" +
      "without --set first if the field (e.g. oauth2.providers) already has content\n" +
      "you need to keep, and include it in the json you send.\n\n" +
      "Examples:\n" +
      "  pb auth users config\n" +
      '  pb auth users config --set \'passwordAuth={"enabled":true,"identityFields":["email"]}\'\n\n' +
      '  Enable Google sign-in on the "users" collection (get clientId/clientSecret\n' +
      "  from a Google Cloud OAuth 2.0 Client ID, with authorized redirect URI\n" +
      "  <your-instance-url>/api/oauth2-redirect):\n" +
      '    pb auth users config --set \'oauth2={"enabled":true,"providers":' +
      '[{"name":"google","clientId":"<GOOGLE_CLIENT_ID>.apps.googleusercontent.com",' +
      '"clientSecret":"<GOOGLE_CLIENT_SECRET>"}]}' + "'\n\n" +
      "  Add Google alongside an existing provider — include every provider you\n" +
      "  want to keep, since the json replaces the whole oauth2 field:\n" +
      '    pb auth users config --set \'oauth2={"enabled":true,"providers":' +
      '[{"name":"github","clientId":"<GITHUB_CLIENT_ID>","clientSecret":"<GITHUB_CLIENT_SECRET>"},' +
      '{"name":"google","clientId":"<GOOGLE_CLIENT_ID>.apps.googleusercontent.com",' +
      '"clientSecret":"<GOOGLE_CLIENT_SECRET>"}]}' + "'",
  );
});

Deno.test("cloud backend deploy has a choices-constrained runtime flag", () => {
  const spec = COMMANDS["cloud backend deploy"];
  const runtime = spec.flags.find((f) => f.name === "runtime");
  assertEquals(runtime?.choices, ["deno", "bun", "nodejs", "nextjs"]);
  // Not required: build.runtime in pb.json, or inference, can supply it.
  assertEquals(runtime?.required, false);
});

Deno.test("no command spec repeats a global flag", () => {
  const globalNames = [
    "json",
    "yes",
    "no-input",
    "project",
    "profile",
    "version",
    "help",
  ];
  for (const [key, spec] of Object.entries(COMMANDS)) {
    for (const f of spec.flags) {
      if (globalNames.includes(f.name)) {
        throw new Error(`${key} lists global flag --${f.name}`);
      }
    }
  }
});
