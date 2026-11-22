import { readDeployCommit } from "../git-commit.ts";
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
import { emit } from "../envelope.ts";
import { removeEnvironment, upsertEnvironment } from "../config.ts";
import {
  awaitDeployment,
  awaitReachable,
  buildBundle,
  computeChooser,
  copyBuildEnv,
  deploymentFailure,
  deployProgress,
  deployResource,
  deployTargetLine,
  isServerEnvironment,
  reportUrl,
  resolveDeployIntent,
  resolveEnvironmentTarget,
  resolveOwnerId,
  sourceHints,
  uploadLabel,
  validateLocationChoice,
} from "./deploy-helper.ts";
import { deployArchive, waitForDeployment } from "../clients/deployments.ts";
import { assertDeployableAs } from "../build/misdirected.ts";
import { buildOverSourceWarning, editedAsSource } from "./revisions.ts";

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
    "website deploy": defineCommand({
      path: ["website", "deploy"],
      needs: ["target:frontends", { explicit: true }],
      usage: "pbc website deploy [--name <name>|--new <name>] [flags]",
      summary: "Build, package, and deploy a static site.",
      details:
        `Runs the build command, zips the output directory, and uploads it. Both
come from the "build" block in pbc.json, inferred from the directory
(vite/svelte/angular/next config, package.json build script) and written
there on the first deploy.

With --source, the directory's source is uploaded instead (without
node_modules, .git, .env files or the build output) and the platform runs the
build. The source is kept, so pbc website revisions and pbc website pull work
on it and it can be edited from the portal or an AI assistant. A Next.js app
with a server is a service: deploy it with pbc service deploy.

Websites have no cloud env store — build-time variables are baked into the
bundle, so there is no --env-file flag here.

A site is served from an address the platform assigns and never changes:
<id>.<compute>.pocketbasecloud.com. To put a domain of your own in front of
it, use pbc website domain add.`,
      args: [],
      flags: {
        name: str({
          description:
            "Which existing website to redeploy; asked for when unbound.",
          conflicts: ["new"],
        }),
        new: str({
          description:
            "Create a new website with this name. Fails if the name is taken.",
          conflicts: ["name"],
        }),
        zip: str({
          description: "Deploy this archive instead of building the directory.",
        }),
        skipBuild: bool({
          description: "Package without running the build command.",
        }),
        source: bool({
          description:
            "Upload the source instead of building here; the platform builds it " +
            "and keeps it, so it can be edited from the portal or an AI assistant.",
          conflicts: ["zip", "skipBuild"],
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
        await assertDeployableAs(
          "frontends",
          { cwd: deps.cwd(), zipPath: input.zip },
        );
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
        log(deployTargetLine(target, KINDS.frontends.label));
        if (
          !target.create && !input.source &&
          await editedAsSource(client, "frontends", target.resource.id)
        ) {
          log(buildOverSourceWarning(target.resource.name, "frontends"));
        }
        const buildEnv = target.create
          ? undefined
          : copyBuildEnv(target.resource);
        if (
          buildEnv && !input.zip && input.skipBuild !== true && !input.source
        ) {
          log(
            `Building with this copy's env (${
              Object.keys(buildEnv).length
            } value(s)).`,
          );
        }
        const bundle = await buildBundle({
          cwd,
          kind: "frontends",
          zipPath: input.zip,
          skipBuild: input.skipBuild === true,
          environment: target.environment,
          log,
          progress,
          buildEnv,
          source: input.source === true,
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
              ...(input.source
                ? {
                  input: "source" as const,
                  hints: sourceHints(bundle.build, buildEnv),
                }
                : {}),
              git: await readDeployCommit(cwd),
              onProgress: (f) =>
                step.update(`Uploading — ${Math.round(f * 100)}%`),
            }, {
              baseUrl: auth.extUrl,
              token: auth.userToken,
              fetchFn: deps.fetch,
            });
            step.update("Uploaded — waiting for the platform to start it");
            const dep = await waitForDeployment(deploymentId, {
              baseUrl: auth.backendUrl,
              token: auth.userToken,
              fetchFn: deps.fetch,
            });
            if (dep.status === "failed") {
              throw await deploymentFailure(
                client,
                "frontends",
                out.resource.id,
                dep.statusMessage,
              );
            }
            step.done(`Uploaded ${bundle.fileName}`);
            return out;
          },
        );

        const { resource, created } = outcome;
        if (!isServerEnvironment(target)) {
          await upsertEnvironment(cwd, {
            projectId: p.id,
            kind: "frontends",
            environment: target.environment,
            entry: { id: resource.id, name: resource.name },
          });
        }
        const final = await awaitDeployment(client, "frontends", resource, {
          progress,
          created,
          label: "website",
          checkCommand: "website",
        });
        reportUrl(final, { log });
        const reachable = await awaitReachable(client, {
          type: "frontend",
          resource: final,
          created,
          log,
          progress,
        });
        if (ctx.flags.json) {
          emit(true, {
            ...final,
            environment: target.environment,
            reachable,
          }, "");
        }
        return 0;
      },
    }),
  };
}
