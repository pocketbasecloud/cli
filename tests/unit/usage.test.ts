import { assertEquals } from "@std/assert";
import { COMMANDS } from "../../src/usage.ts";
import { registerCommands } from "../../src/commands/index.ts";
import type { CommandRegistry } from "../../src/command.ts";
import { canonicalKeys } from "../../src/command.ts";
import { GLOBAL_FLAG_NAMES, GLOBAL_FLAGS } from "../../src/globals.ts";

Deno.test("--project stays a global filter, and no usage string advertises it", () => {
  for (const [key, spec] of Object.entries(COMMANDS)) {
    assertEquals(
      spec.usage.includes("--project"),
      false,
      `${key} usage still names --project`,
    );
  }
  const project = GLOBAL_FLAGS.find((f) => f.name === "project");
  assertEquals(project?.type, "string");
  assertEquals(project?.description?.includes("Narrow"), true);
});

Deno.test("--profile reaches every instance command, so no usage string advertises it either", () => {
  for (const [key, spec] of Object.entries(COMMANDS)) {
    assertEquals(
      spec.usage.includes("--profile"),
      false,
      `${key} usage still names --profile`,
    );
  }
  const profile = GLOBAL_FLAGS.find((f) => f.name === "profile");
  assertEquals(profile?.type, "string");
});

Deno.test("COMMANDS has exactly one entry per registered command, no orphans", () => {
  const registry: CommandRegistry = {};
  registerCommands(registry);
  assertEquals(Object.keys(COMMANDS).sort(), canonicalKeys(registry).sort());
});

Deno.test("a single-paragraph command's rendered text matches the original prose", () => {
  const spec = COMMANDS["project create"];
  assertEquals(
    [spec.usage, spec.summary, spec.details].filter(Boolean).join("\n\n"),
    "pbc project create <name>\n\nCreate a project.",
  );
  assertEquals(spec.args, [{ name: "name", required: true }]);
  assertEquals(spec.flags, []);
});

Deno.test("a multi-paragraph command (auth) reconstructs identically to the original prose", () => {
  const spec = COMMANDS["admin auth"];
  const rebuilt = [spec.usage, spec.summary, spec.details].filter(Boolean)
    .join("\n\n");
  assertEquals(
    rebuilt,
    "pbc admin auth <collection> config [--set '<field>=<json>']\n\n" +
      "View or edit an auth collection's auth-related settings.\n\n" +
      "Without --set, prints the current value of: authRule, manageRule, authAlert,\n" +
      "oauth2, passwordAuth, mfa, otp, verificationTemplate, resetPasswordTemplate.\n\n" +
      "With --set '<field>=<json>', replaces that one field's value entirely — run\n" +
      "without --set first if the field (e.g. oauth2.providers) already has content\n" +
      "you need to keep, and include it in the json you send.\n\n" +
      "Examples:\n" +
      "  pbc admin auth users config\n" +
      '  pbc admin auth users config --set \'passwordAuth={"enabled":true,"identityFields":["email"]}\'\n\n' +
      '  Enable Google sign-in on the "users" collection (get clientId/clientSecret\n' +
      "  from a Google Cloud OAuth 2.0 Client ID, with authorized redirect URI\n" +
      "  <your-instance-url>/api/oauth2-redirect):\n" +
      '    pbc admin auth users config --set \'oauth2={"enabled":true,"providers":' +
      '[{"name":"google","clientId":"<GOOGLE_CLIENT_ID>.apps.googleusercontent.com",' +
      '"clientSecret":"<GOOGLE_CLIENT_SECRET>"}]}' + "'\n\n" +
      "  Add Google alongside an existing provider — include every provider you\n" +
      "  want to keep, since the json replaces the whole oauth2 field:\n" +
      '    pbc admin auth users config --set \'oauth2={"enabled":true,"providers":' +
      '[{"name":"github","clientId":"<GITHUB_CLIENT_ID>","clientSecret":"<GITHUB_CLIENT_SECRET>"},' +
      '{"name":"google","clientId":"<GOOGLE_CLIENT_ID>.apps.googleusercontent.com",' +
      '"clientSecret":"<GOOGLE_CLIENT_SECRET>"}]}' + "'",
  );
});

Deno.test("cloud backend deploy has a choices-constrained runtime flag", () => {
  const spec = COMMANDS["backend deploy"];
  const runtime = spec.flags.find((f) => f.name === "runtime");
  assertEquals(runtime?.choices, ["deno", "bun", "nodejs", "nextjs"]);
  assertEquals(runtime?.required, false);
});

Deno.test("ci init --env does not claim PBC_ENV is honoured", () => {
  const spec = COMMANDS["ci init"];
  const env = spec.flags.find((f) => f.name === "env");
  assertEquals(env?.type, "string");
  assertEquals(env?.description?.includes("PBC_ENV is ignored"), true);
  assertEquals(env?.description?.includes("PBC_ENV sets it"), false);
});

Deno.test("no command spec repeats a global flag", () => {
  for (const [key, spec] of Object.entries(COMMANDS)) {
    for (const f of spec.flags) {
      if (GLOBAL_FLAG_NAMES.has(f.name)) {
        throw new Error(`${key} lists global flag --${f.name}`);
      }
    }
  }
});
