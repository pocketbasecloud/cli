import { dispatch } from "./src/router.ts";
import type { CommandRegistry } from "./src/command.ts";
import { parseGlobalFlags, splitPathAndFlags } from "./src/globals.ts";
import { resolveCommand } from "./src/parse.ts";
import { VERSION } from "./src/version.ts";
import { CliError } from "./src/errors.ts";
import { emit, emitError } from "./src/envelope.ts";

export const registry: CommandRegistry = {};

export async function run(argv: string[]): Promise<number> {
  const { path, rest } = resolveCommand(argv, registry);
  const globals = parseGlobalFlags(rest);

  if (path.length === 0) {
    const misordered = splitPathAndFlags(argv);
    if (misordered.path.length > 0) {
      const err = new CliError(
        "the command comes before its flags — try " +
          `\`pbc ${[...misordered.path, ...misordered.flags].join(" ")}\`.`,
        { code: "USAGE" },
      );
      console.error(`Error: ${err.message}`);
      emitError(globals.json, err);
      return err.exitCode;
    }
  }

  if (path.length === 0 && globals.version) {
    emit(globals.json, { version: VERSION }, `pbc ${VERSION}`);
    return 0;
  }

  const { registerCommands } = await import("./src/commands/index.ts");
  registerCommands(registry);

  if (path.length === 0 || path[0] === "help") {
    const { buildHelpText, buildManifest } = await import("./src/help.ts");
    emit(globals.json, buildManifest(registry), () => buildHelpText(registry));
    return 0;
  }

  return dispatch(registry, argv);
}

if (import.meta.main) {
  const { buildNotifyDeps, notifyUpdate } = await import(
    "./src/self/notify.ts"
  );
  const notifyDeps = buildNotifyDeps();
  const first = await notifyUpdate(Deno.args, notifyDeps, { before: true });
  const code = await run(Deno.args);
  if (first === "unknown") await notifyUpdate(Deno.args, notifyDeps);
  Deno.exit(code);
}
