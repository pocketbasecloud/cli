import { assertEquals } from "@std/assert";
import {
  bool,
  camelCase,
  defineCommand,
  kebabCase,
  path,
  renamed,
  requiresExplicitTarget,
  retired,
  str,
  targetKindOf,
} from "../../src/command.ts";
import type { CmdCtx } from "../../src/command.ts";

Deno.test("builders produce the right spec objects", () => {
  assertEquals(str({ description: "d", required: true }), {
    type: "string", description: "d", required: true,
  });
  assertEquals(path({ description: "p" }), {
    type: "path", description: "p", required: false,
  });
  assertEquals(bool({ description: "b" }), {
    type: "boolean", description: "b", required: false,
  });
  assertEquals(renamed("compute", { description: "old" }), {
    type: "string", description: "old", required: false, renamedTo: "compute",
  });
  assertEquals(
    retired({ since: "0.6.0", note: "uid addresses", description: "sub" }),
    { type: "string", description: "sub", required: false,
      retired: { since: "0.6.0", note: "uid addresses" } },
  );
});

Deno.test("kebabCase and camelCase round-trip CLI flag names", () => {
  for (const name of [
    "env-file", "delete-missing", "pb-version", "no-input", "per-page",
    "admin-email", "force-env", "skip-build", "name", "compute", "follow",
  ]) {
    assertEquals(kebabCase(camelCase(name)), name);
  }
  assertEquals(camelCase("env-file"), "envFile");
  assertEquals(camelCase("pb-version"), "pbVersion");
  assertEquals(camelCase("name"), "name");
  assertEquals(kebabCase("envFile"), "env-file");
  assertEquals(kebabCase("deleteMissing"), "delete-missing");
});

Deno.test("defineCommand stores the declaration and widens run for the registry", async () => {
  const ctx: CmdCtx = { args: [], flags: {} as never };
  const cmd = defineCommand({
    path: ["cloud", "pb", "deploy"],
    usage: "pbc cloud pb deploy",
    summary: "Deploy.",
    args: [],
    flags: {
      name: str({ description: "Which instance." }),
      skipBuild: bool({ description: "Skip the build." }),
      envFile: path({ description: "Dotenv file." }),
    },
    run: (input) => {
      return Promise.resolve(input.skipBuild ? 0 : 1);
    },
  });
  assertEquals(cmd.path, ["cloud", "pb", "deploy"]);
  assertEquals(cmd.summary, "Deploy.");
  const code = await cmd.run({ name: "api", skipBuild: true }, ctx);
  assertEquals(code, 0);
});

Deno.test("defineCommand carries needs through, and the readers see it", () => {
  const cmd = defineCommand({
    path: ["cloud", "pb", "rm"],
    usage: "pbc cloud pb rm",
    summary: "Delete.",
    needs: ["target:pocketbases", { explicit: true }],
    flags: {},
    run: () => Promise.resolve(0),
  });
  assertEquals(cmd.needs, ["target:pocketbases", { explicit: true }]);
  assertEquals(targetKindOf(cmd), "pocketbases");
  assertEquals(requiresExplicitTarget(cmd), true);

  const read = defineCommand({
    path: ["cloud", "pb", "info"],
    usage: "pbc cloud pb info",
    summary: "Show.",
    needs: ["target:pocketbases"],
    flags: {},
    run: () => Promise.resolve(0),
  });
  assertEquals(requiresExplicitTarget(read), false);
  assertEquals(targetKindOf({ needs: undefined }), undefined);
});

Deno.test("renamed and retired flags produce no input key", () => {
  const cmd = defineCommand({
    path: ["x"],
    usage: "pbc x",
    summary: "",
    flags: {
      compute: str({ description: "c" }),
      server: renamed("compute", { description: "old spelling" }),
      subdomain: retired({ since: "0.6.0", note: "n/a", description: "s" }),
    },
    run: (input) => {
      // @ts-expect-error — renamedTo flags are folded into the target, not present
      input.server;
      // @ts-expect-error — retired flags never appear in input
      input.subdomain;
      return Promise.resolve(0);
    },
  });
  assertEquals(Object.keys(cmd.flags).sort(), ["compute", "server", "subdomain"]);
});

Deno.test("renamed keeps the short alias it was given", () => {
  assertEquals(
    renamed("compute", { description: "old spelling", short: "s" }),
    {
      type: "string",
      description: "old spelling",
      required: false,
      short: "s",
      renamedTo: "compute",
    },
  );
  assertEquals(
    "short" in renamed("compute", { description: "old spelling" }),
    false,
  );
});
