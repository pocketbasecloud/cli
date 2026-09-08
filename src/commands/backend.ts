import {
  bool,
  type CmdCtx,
  type Command,
  defineCommand,
  path,
  renamed,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import { CliError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { KINDS } from "../kinds.ts";
import { resolveProject } from "../resolve/project.ts";
import {
  removeEnvironment,
  upsertEnvironment,
} from "../config.ts";
import {
  awaitDeployment,
  awaitReachable,
  buildBundle,
  computeChooser,
  deployProgress,
  deployResource,
  ensureBackendProject,
  envFileEntry,
  pushEnvFile,
  reportUrl,
  resolveDeployIntent,
  resolveEnvFile,
  resolveEnvironmentTarget,
  resolveOwnerId,
  uploadLabel,
} from "./deploy-helper.ts";
import { deployArchive, waitForDeployment } from "../clients/deployments.ts";

export function makeBackendCommands(
  deps: CloudCmdDeps,
): Record<string, Command> {
  async function project(ctx: CmdCtx, log?: (m: string) => void) {
    const { client, config, auth } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput || ctx.flags.json,
      log: log ?? ((m) => console.error(m)),
    });
    return { client, project: p, auth };
  }

  return {
    "backend deploy": defineCommand({
      path: ["backend", "deploy"],
      needs: ["target:backends", { explicit: true }],
      usage:
        "pbc backend deploy [--name <name>] [--new <name>] [--runtime <deno|bun|nodejs|nextjs>] [--start <cmd>] [--compute <id>] [--skip-env] [--zip <file>] [--env <name>]",
      summary: "Build, package, and deploy a backend.",
      details:
        `Runs the build command and uploads the result. The runtime, build command,
and output directory come from the "build" block in pbc.json, inferred from the
directory (deno.json, bun.lockb, next.config.*, package.json) and written there
on the first deploy.

deno, bun, and nodejs ship their source — the platform installs dependencies on
start, so node_modules is excluded.

Where there is a build command, it needs its dependencies, so deploy installs
them first when something package.json declares is not installed — with the
package manager the lockfile names, at the workspace root when the project is
one. This is what keeps a Next.js deploy from a fresh clone or a CI runner from
dying on "next: not found". A tree that is already installed is left alone;
"install" in the build block sets the command outright, and "" turns the step
off.

nextjs ships a prebuilt bundle: the platform does not run next build (it
exhausts memory on a shared host). That bundle only exists when the build asks
for it, so deploy adds output: "standalone" to next.config.* before building
(creating the file if the project has none) and says so — the CLI then
assembles .next/standalone, .next/static, and public into the layout the
runtime expects, defaulting the start command to "node server.js". A config
that already sets output is left alone; output: "export" is a static site, so
deploy it with "pbc frontend deploy" instead.

Each wait — installing, building, packaging, uploading, provisioning, waiting
for the domain — is reported as its own step, with a spinner and the elapsed
time on a terminal, plain lines when the output is piped, and nothing at all
under --json.

Env vars are pushed only from the file you name — nothing is uploaded by
default. Each environment has its own: the first deploy of an environment asks
which dotenv file it uses (or none) and records the answer as envFile under
that environment in pbc.json, so it is asked once. --env-file names one outright
and is recorded the same way when the environment has none yet. Pushing merges,
keeping cloud-only keys; --delete-missing removes them so the file is the whole
truth, and --skip-env pushes nothing for this run. A file whose variables are
unchanged since the last push is not uploaded again — pass --force-env to push
it anyway, e.g. after editing the variables in the portal.

With no --name and nothing bound in pbc.json, deploy asks which backend to
redeploy — or what to call a new one — the way it already asks which project
to use. Pass --no-input (or --json) to get the usage error instead.

Creating a backend also picks the compute it runs on: the project owner's, so
a developer in a shared organization project deploys onto the owner's Pro
compute (and against the owner's plan) without needing to see it. A single
compute is used, several are offered as a menu, and --compute settles it
outright. A redeploy never moves an existing backend.

Backends run on a Pro organization's compute. When the project the deploy
resolves to is on the free or starter plan, deploy lists your other projects
so you can send the backend to one that qualifies; under --no-input or --json
it asks for --project instead.`,
      args: [],
      flags: {
        name: str({
          description:
            "Which existing backend to redeploy. Asked for when omitted and pbc.json has no binding.",
          conflicts: ["new"],
        }),
        new: str({
          description:
            "Create a new backend with this name. Fails if the name is taken.",
          conflicts: ["name"],
        }),
        runtime: str({
          description: "Defaults to build.runtime in pbc.json, else inferred.",
          choices: ["deno", "bun", "nodejs", "nextjs"],
        }),
        start: str({
          description: "Command to run. Defaults to build.startCommand, then inference.",
        }),
        compute: str({
          description:
            "Compute to create the backend on. Asked for when the project owner " +
            "has more than one; required under --no-input/--json.",
        }),
        server: renamed("compute", {
          description: "Old name for --compute; scripts may keep using it.",
        }),
        zip: str({
          description:
            "Upload this archive instead of packaging the directory.",
        }),
        skipBuild: bool({
          description: "Package without running the build command.",
        }),
        skipEnv: bool({
          description:
            "Push no env vars for this run, whatever pbc.json configures.",
        }),
        envFile: path({
          description:
            "Dotenv file to push. Recorded in pbc.json for this environment " +
            "when it has none yet.",
        }),
        deleteMissing: bool({
          description: "Remove cloud env vars the pushed file does not list.",
        }),
        forceEnv: bool({
          description:
            "Push env vars even when they are unchanged since the last push.",
        }),
        env: str({
          description:
            "Which pbc.json environment to target. Defaults to the file's " +
            "default, or production.",
        }),
      },
      run: async (input, ctx) => {
        const progress = deployProgress(ctx.flags.json);
        const { client, project: p, auth } = await progress.step(
          "Connecting to PocketBase Cloud",
          () => project(ctx, progress.log),
        );
        const cwd = deps.cwd();
        const name = input.name ?? ctx.args[0];
        const log = (m: string) => progress.log(m);
        const noInput = ctx.flags.noInput || ctx.flags.json;
        const envTarget = await resolveEnvironmentTarget(
          { name },
          "backends",
          cwd,
          {
            envFlag: input.env,
            allowNewEnvironment: true,
            strictKind: true,
            askEnvironment: { noInput },
          },
        );
        const intentFor = (projectId: string) =>
          resolveDeployIntent(envTarget, {
            client,
            spec: KINDS.backends,
            projectId,
            cwd,
            newName: input.new,
            noInput,
            io: deps.io,
            onStale: () => removeEnvironment(cwd, envTarget.environment),
          });
        let deployProject = p;
        let target = await intentFor(deployProject.id);
        if (target.create) {
          const chosen = await ensureBackendProject(client, deployProject, {
            noInput,
            io: deps.io,
            log,
          });
          if (chosen.id !== deployProject.id) {
            deployProject = chosen;
            target = await intentFor(deployProject.id);
          }
        }
        const bundle = await buildBundle({
          cwd,
          kind: "backends",
          zipPath: input.zip,
          skipBuild: input.skipBuild === true,
          runtime: input.runtime,
          envFile: input.envFile,
          environment: target.environment,
          log,
          progress,
        });
        const env = await resolveEnvFile({
          cwd,
          build: bundle.build,
          environment: target.environment,
          flag: input.envFile,
          skip: input.skipEnv === true,
          noInput,
        });
        const runtime = input.runtime ?? bundle.build.runtime;
        if (!runtime) {
          throw new CliError(
            "Pass --runtime (deno|bun|nodejs|nextjs) or set build.runtime in pbc.json.",
            { code: "USAGE" });
        }
        const data: Record<string, unknown> = {
          project: deployProject.id,
          runtime,
        };
        const compute = input.compute;
        if (compute) data.server = compute;
        const start = input.start ?? bundle.build.startCommand ??
          bundle.startCommand;
        if (start) data.startCommand = start;
        if (!start && target.create) {
          throw new CliError(
            `No start command for this ${runtime} backend. Add a "start" ` +
              `${
                runtime === "deno" ? "task to deno.json" : "script to package.json"
              }, ` +
              `set build.startCommand in pbc.json, or pass --start "<command>".`,
              { code: "USAGE" });
        }
        const askCompute = computeChooser(client, deployProject.id, {
          noInput,
          log,
        });
        const { resource, created } = await progress.step(
          uploadLabel(bundle),
          async (step) => {
            const out = await deployResource(
              client,
              "backends",
              target,
              {
                data,
                createData: async () => {
                  const fields: Record<string, unknown> = {
                    user: await resolveOwnerId(client, auth),
                    status: "pending",
                  };
                  if (!data.server) {
                    const picked = await askCompute();
                    if (picked) fields.server = picked;
                  }
                  return fields;
                },
              },
            );
            const { deploymentId } = await deployArchive({
              kind: "backends",
              resourceId: out.resource.id,
              bytes: bundle.bytes,
              onProgress: (f) =>
                step.update(`Uploading — ${Math.round(f * 100)}%`),
            }, { baseUrl: auth.extUrl, token: auth.userToken, fetchFn: deps.fetch });
            const dep = await waitForDeployment(deploymentId, {
              baseUrl: auth.backendUrl,
              token: auth.userToken,
              fetchFn: deps.fetch,
            });
            if (dep.status === "failed") {
              throw new CliError(dep.statusMessage, { code: "PLATFORM_ERROR" });
            }
            return out;
          },
        );
        await upsertEnvironment(cwd, {
          projectId: deployProject.id,
          kind: "backends",
          environment: target.environment,
          entry: {
            id: resource.id,
            name: resource.name,
            ...await envFileEntry(cwd, target.environment, env, log),
          },
        });
        if (env.push) {
          await pushEnvFile(client, {
            targetId: resource.id,
            type: "backend",
            name: env.push.name,
            vars: env.push.vars,
            deleteMissing: input.deleteMissing === true,
            force: input.forceEnv === true,
            statePath: deps.envStatePath?.(),
            log,
            progress,
          });
        }
        const final = await awaitDeployment(client, "backends", resource, {
          progress,
          created,
          environment: target.environment,
          label: "backend",
          checkCommand: "backend",
        });
        if (final.status === "running") reportUrl(final, { log });
        const reachable = created && final.status === "running"
          ? await awaitReachable(client, {
            type: "backend",
            resource: final,
            log,
            progress,
          })
          : undefined;
        if (ctx.flags.json) {
          emit(true, {
            ...final,
            environment: target.environment,
            ...(reachable === undefined ? {} : { reachable }),
          }, "");
        }
        return final.status === "running" ? 0 : 6;
      },
    }),

  };
}
