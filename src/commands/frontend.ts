import {
  bool,
  type CmdCtx,
  type Command,
  defineCommand,
  renamed,
  retired,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import { KINDS } from "../kinds.ts";
import { resolveProject } from "../resolve/project.ts";
import { CliError } from "../errors.ts";
import { emit } from "../envelope.ts";
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
  reportUrl,
  resolveOwnerId,
  resolveDeployIntent,
  resolveEnvironmentTarget,
  uploadLabel,
  validateLocationChoice,
} from "./deploy-helper.ts";
import { deployArchive, waitForDeployment } from "../clients/deployments.ts";

export function makeFrontendCommands(
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
    "frontend deploy": defineCommand({
      path: ["frontend", "deploy"],
      needs: ["target:frontends", { explicit: true }],
      usage: "pbc frontend deploy [--name <name>|--new <name>] [flags]",
      summary: "Build, package, and deploy a static site.",
      details: `Runs the build command, zips the output directory, and uploads it. Both
come from the "build" block in pbc.json, inferred from the directory
(vite/svelte/angular/next config, package.json build script) and written
there on the first deploy.

Frontends have no cloud env store — build-time variables are baked into the
bundle, so there is no --env-file flag here.

A site is served from an address the platform assigns and never changes:
<id>.<compute>.pocketbasecloud.com. To put a domain of your own in front of
it, use pbc frontend domain add.`,
      args: [],
      flags: {
        name: str({
          description:
            "Which existing frontend to redeploy; asked for when unbound.",
          conflicts: ["new"],
        }),
        new: str({
          description:
            "Create a new frontend with this name. Fails if the name is taken.",
          conflicts: ["name"],
        }),
        zip: str({
          description:
            "Deploy this archive instead of building the directory.",
        }),
        skipBuild: bool({
          description: "Package without running the build command.",
        }),
        location: str({
          description:
            "Region for the deploy. The platform picks when omitted.",
        }),
        compute: str({
          description:
            "Compute to create on; asked for when there is a choice, or required " +
            "under --no-input/--json.",
        }),
        server: renamed("compute", {
          description: "Old name for --compute; scripts may keep using it.",
        }),
        env: str({
          description:
            "Which pbc.json environment; defaults to the file's default or " +
            "production.",
        }),
        subdomain: retired({
          description: "",
          since: "0.6.0",
          note: "Frontends use uid addresses.",
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
        const envTarget = await resolveEnvironmentTarget(
          { name },
          "frontends",
          cwd,
          {
            envFlag: input.env,
            allowNewEnvironment: true,
            strictKind: true,
            askEnvironment: { noInput: ctx.flags.noInput || ctx.flags.json },
          },
        );
        const target = await resolveDeployIntent(envTarget, {
          client,
          spec: KINDS.frontends,
          projectId: p.id,
          cwd,
          newName: input.new,
          noInput: ctx.flags.noInput || ctx.flags.json,
          io: deps.io,
          onStale: () => removeEnvironment(cwd, envTarget.environment),
        });
        const log = (m: string) => progress.log(m);
        const bundle = await buildBundle({
          cwd,
          kind: "frontends",
          zipPath: input.zip,
          skipBuild: input.skipBuild === true,
          environment: target.environment,
          log,
          progress,
        });
        const data: Record<string, unknown> = { project: p.id };
        if (input.location) data.location = input.location;
        const compute = input.compute;
        if (compute) data.server = compute;
        const askCompute = computeChooser(client, p.id, {
          noInput: ctx.flags.noInput || ctx.flags.json,
          log,
        });
        const outcome = await progress.step(
          uploadLabel(bundle),
          async (step) => {
            const out = await deployResource(client, "frontends", target, {
              data,
              createData: async () => {
                const fields: Record<string, unknown> = {
                  user: await resolveOwnerId(client, auth),
                  status: "pending",
                };
                if (!data.server) {
                  const picked = await askCompute();
                  if (picked) fields.server = picked;
                  else if (input.location) {
                    await validateLocationChoice(
                      client,
                      p.id,
                      input.location,
                    );
                  }
                }
                return fields;
              },
            });
            const { deploymentId } = await deployArchive({
              kind: "frontends",
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

        const { resource, created } = outcome;
        await upsertEnvironment(cwd, {
          projectId: p.id,
          kind: "frontends",
          environment: target.environment,
          entry: { id: resource.id, name: resource.name },
        });
        const final = await awaitDeployment(client, "frontends", resource, {
          progress,
          created,
          environment: target.environment,
          label: "frontend",
          checkCommand: "frontend",
        });
        if (final.status === "running") reportUrl(final, { log });
        const reachable = created && final.status === "running"
          ? await awaitReachable(client, {
            type: "frontend",
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
