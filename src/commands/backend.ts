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
import { reportDeploymentLogs } from "./logs.ts";

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
      usage: "pbc backend deploy [--name <name>|--new <name>] [flags]",
      summary: "Build, package, and deploy a backend.",
      details: `Runs the build command and uploads the result. The runtime, build command,
and output directory come from the "build" block in pbc.json, inferred from the
directory (deno.json, bun.lockb, next.config.*, package.json) and written there
on the first deploy.

deno, bun, and nodejs ship their source — the platform installs dependencies
on start, so node_modules is excluded. Where there is a build command, deploy
installs its dependencies first when they are missing, with the package
manager the lockfile names.

nextjs ships a prebuilt bundle: deploy adds output: "standalone" to
next.config.* before building (and says so) unless the config already sets
output, then assembles .next/standalone, .next/static, and public, starting
with node server.js. output: "export" is a static site — deploy it with
pbc frontend deploy instead.`,
      args: [],
      flags: {
        name: str({
          description:
            "Which existing backend to redeploy; asked for when unbound.",
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
          description: "Command to run; defaults to build.startCommand.",
        }),
        compute: str({
          description:
            "Compute to create on; asked for when there is a choice, or required " +
            "under --no-input/--json.",
        }),
        server: renamed("compute", {
          description: "Old name for --compute; scripts may keep using it.",
        }),
        zip: str({
          description:
            "Deploy this archive instead of building the directory.",
        }),
        skipBuild: bool({
          description: "Package without running the build command.",
        }),
        skipEnv: bool({
          description: "Push no env vars this run.",
        }),
        envFile: path({
          description:
            "Dotenv file to push; recorded in pbc.json for this environment.",
        }),
        deleteMissing: bool({
          description: "Remove cloud vars the file does not list.",
        }),
        forceEnv: bool({
          description: "Push even when unchanged since the last push.",
        }),
        env: str({
          description:
            "Which pbc.json environment; defaults to the file's default or " +
            "production.",
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
            await reportDeploymentLogs(client, {
              type: "backend",
              targetId: out.resource.id,
              log: ctx.flags.json ? (m) => console.error(m) : log,
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
