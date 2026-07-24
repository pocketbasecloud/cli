import type { CmdCtx, Handler } from "../router.ts";
import type { ResourceKind } from "../clients/types.ts";
import { CliError } from "../errors.ts";
import { readOwnPbJson, upsertBuildConfig } from "../config.ts";
import { parseKind } from "../resolve/link.ts";
import { describeBuild, inferBuild } from "../build/detect.ts";

export const INIT_USAGE = "Usage: pb cloud init [pb|frontend|backend]";

/**
 * Writes the directory's `build` block without touching the cloud.
 *
 * Deploy infers the same block on its own, but doing it here first makes the
 * guess reviewable — and editable — before anything ships.
 */
export function makeCloudInitCommands(
  deps: { cwd: () => string },
): Record<string, Handler> {
  const init: Handler = async (ctx: CmdCtx) => {
    const cwd = deps.cwd();
    const own = await readOwnPbJson(cwd);

    const token = ctx.args[0];
    let kind: ResourceKind | undefined;
    if (token) {
      const parsed = parseKind(token);
      if (!parsed) {
        throw new CliError(`Unknown kind "${token}". ${INIT_USAGE}`, 2);
      }
      kind = parsed;
    } else {
      // The kind is shared by every environment, so it needs no --env here.
      kind = own.kind;
    }
    if (!kind) {
      throw new CliError(
        `This directory is not bound to a resource, so there is no kind to ` +
          `infer for. ${INIT_USAGE}, or run \`pb cloud link\` first.`,
        2,
      );
    }

    if (own.build && ctx.raw.force !== true) {
      if (ctx.flags.json) {
        console.log(JSON.stringify({ build: own.build, written: false }));
      } else {
        console.log(`pb.json already has a "build" block:`);
        for (const line of describeBuild(own.build)) console.log(line);
        console.log(`Pass --force to re-infer it from the directory.`);
      }
      return 0;
    }

    const build = await inferBuild(cwd, kind);
    await upsertBuildConfig(cwd, build);
    if (ctx.flags.json) {
      console.log(JSON.stringify({ build, written: true }));
    } else {
      console.log(`Inferred the build config for this ${token ?? kind}:`);
      for (const line of describeBuild(build)) console.log(line);
      console.log(`Wrote it to pb.json. Edit it there, then run deploy.`);
    }
    return 0;
  };

  return { "cloud init": init };
}
