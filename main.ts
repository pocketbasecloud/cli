import { dispatch, type Handler, parseGlobal } from "./src/router.ts";
import { COMMANDS } from "./src/usage.ts";
import { VERSION } from "./src/version.ts";

// Registry is populated as command modules land. Imported lazily to keep startup light.
export const registry: Record<string, Handler> = {};

export async function run(argv: string[]): Promise<number> {
  const { path, ctx } = parseGlobal(argv);

  // `--version`/`-v` is the CLI's own version only when it stands alone —
  // otherwise `pb install 0.39.9 --version` would never reach the command.
  if (
    path.length === 0 && (argv.includes("--version") || argv.includes("-v"))
  ) {
    console.log(`pb ${VERSION}`);
    return 0;
  }

  const { registerCommands } = await import("./src/commands/index.ts");
  registerCommands(registry);

  // Bare `--help`/`-h`/`help` (no command) shows the full command list.
  // `<command> --help` is handled per-command inside dispatch.
  if (path.length === 0 || path[0] === "help") {
    const { buildHelpText, buildManifest } = await import("./src/help.ts");
    console.log(
      ctx.flags.json
        ? JSON.stringify(buildManifest(registry), null, 2)
        : buildHelpText(registry),
    );
    return 0;
  }

  return dispatch(registry, argv, COMMANDS);
}

if (import.meta.main) {
  // The update notice is a courtesy and must never delay the work, so it runs
  // twice with different budgets. The pass before the command reads the cache
  // and nothing else — free, and the only pass a command that never returns
  // (`pb cloud logs --follow`) will ever reach. The pass after is the one
  // allowed to hit the network and refresh that cache, and it is skipped when
  // the first already spoke. Imported here so `run()` stays importable without
  // it.
  const { buildNotifyDeps, notifyUpdate } = await import(
    "./src/self/notify.ts"
  );
  const notifyDeps = buildNotifyDeps();
  const first = await notifyUpdate(Deno.args, notifyDeps, { before: true });
  const code = await run(Deno.args);
  // "unknown" is the only verdict a second look can improve on, so on all but
  // the once-a-day refresh this costs nothing at all.
  if (first === "unknown") await notifyUpdate(Deno.args, notifyDeps);
  Deno.exit(code);
}
