import {
  bool,
  type Command,
  defineCommand,
  str,
} from "../command.ts";
import type { ResourceKind } from "../clients/types.ts";
import { CliError } from "../errors.ts";
import { emit } from "../envelope.ts";
import {
  linkFileName,
  readOwnLinkFile,
  setDefaultEnvironment,
  upsertBuildConfig,
} from "../config.ts";
import { parseKind } from "../resolve/link.ts";
import type { PromptIO } from "../ui/prompt.ts";
import { describeBuild, inferBuild } from "../build/detect.ts";
import {
  chooseEnvironment,
  resolveEnvironmentName,
} from "../resolve/environment.ts";

export const INIT_USAGE = "Usage: pbc init [pocketbase|frontend|backend]";

export function makeCloudInitCommands(
  deps: { cwd: () => string; io?: PromptIO },
): Record<string, Command> {
  return {
    init: defineCommand({
      path: ["init"],
      usage: "pbc init [pocketbase|frontend|backend] [--force] [--env <name>]",
      summary: "Write this directory's build config into pbc.json.",
      details: `Inspects the directory and records how it should be built and packaged:
the build command, the output directory, the backend runtime, or a
PocketBase project's pb_public / pb_hooks / pb_migrations paths.

Deploy infers the same block when pbc.json has none, so this command is
optional — it just lets you see and edit the guess before anything ships.
Nothing in the cloud is touched, and no login is needed.

The kind comes from the argument, or from the directory's existing resource
binding. An existing block is left alone unless --force is passed.

On a terminal it also asks which environment this directory deploys to, and
records it as the default, so the first deploy has nothing left to ask.`,
      args: [{
        name: "kind",
        required: false,
        description: "pocketbase, frontend, or backend; defaults to the bound resource",
      }],
      flags: {
        force: bool({ description: "Overwrite an existing build block." }),
        env: str({
          description: "Which pbc.json environment to make the default.",
        }),
      },
      run: async (input, ctx) => {
        const cwd = deps.cwd();
        const own = await readOwnLinkFile(cwd);

        const token = ctx.args[0];
        let kind: ResourceKind | undefined;
        if (token) {
          const parsed = parseKind(token);
          if (!parsed) {
            throw new CliError(
              `Unknown kind "${token}". ${INIT_USAGE}`,
              { code: "USAGE" },
            );
          }
          kind = parsed;
        } else {
          kind = own.kind;
        }
        if (!kind) {
          throw new CliError(
            `This directory is not bound to a resource, so there is no kind to ` +
              `infer for. ${INIT_USAGE}, or run a deploy first — it records the ` +
              `binding in pbc.json.`,
              { code: "USAGE" });
        }

        if (own.build && input.force !== true) {
          const linkFile = await linkFileName(cwd);
          emit(
            ctx.flags.json,
            { build: own.build, written: false },
            [
              `${linkFile} already has a "build" block:`,
              ...describeBuild(own.build!),
              `Pass --force to re-infer it from the directory.`,
            ].join("\n"),
          );
          return 0;
        }

        const build = await inferBuild(cwd, kind);
        await upsertBuildConfig(cwd, build);
        const environment = (await chooseEnvironment(
          resolveEnvironmentName(own, { flag: input.env }),
          own,
          { noInput: ctx.flags.noInput || ctx.flags.json, io: deps.io },
        )).name;
        await setDefaultEnvironment(cwd, environment);
        const linkFile = await linkFileName(cwd);
        emit(
          ctx.flags.json,
          { build, environment, written: true },
          [
            `Inferred the build config for this ${token ?? kind}:`,
            ...describeBuild(build),
            `Wrote it to ${linkFile} (environment: ${environment}). ` +
              `Edit it there, then run deploy.`,
          ].join("\n"),
        );
        return 0;
      },
    }),
  };
}
