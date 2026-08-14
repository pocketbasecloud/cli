import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { CliError } from "../errors.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";
import {
  removeEnvironment,
  removeEnvironmentFor,
  upsertEnvironment,
} from "../config.ts";
import {
  attachZip,
  awaitDeployment,
  awaitReachable,
  buildBundle,
  computeChooser,
  computeFlag,
  deployProgress,
  deployResource,
  ensureTarget,
  envFileEntry,
  pushEnvFile,
  reportUrl,
  resolveEnvFile,
  resolveExisting,
  resolveOwnerId,
  resolveTarget,
  uploadLabel,
} from "./deploy-helper.ts";
import { reportRemoval } from "./environments.ts";

export function makeBackendCommands(
  deps: CloudCmdDeps,
): Record<string, Handler> {
  async function ctxProject(ctx: CmdCtx, log?: (m: string) => void) {
    const { client, config, auth } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput || ctx.flags.json,
      log: log ?? (ctx.flags.json ? undefined : (m) => console.log(m)),
    });
    return { client, project: p, auth };
  }

  const deploy: Handler = async (ctx: CmdCtx) => {
    const progress = deployProgress(ctx.flags.json);
    const { client, project: p, auth } = await progress.step(
      "Connecting to PocketBase Cloud",
      () => ctxProject(ctx, progress.log),
    );
    const cwd = deps.cwd();
    const name = (ctx.raw.name as string) ?? ctx.args[0];
    const id = ctx.raw.id as string | undefined;
    const target = await ensureTarget(
      await resolveTarget({ id, name }, "backends", cwd, {
        envFlag: ctx.raw.env as string | undefined,
        allowNewEnvironment: true,
        strictKind: true,
        askEnvironment: { noInput: ctx.flags.noInput || ctx.flags.json },
      }),
      {
        label: "backend",
        cwd,
        list: () => client.listResources("backends", p.id),
        noInput: ctx.flags.noInput || ctx.flags.json,
      },
    );
    const log = (m: string) => progress.log(m);
    const bundle = await buildBundle({
      cwd,
      kind: "backends",
      zipPath: ctx.raw.zip as string | undefined,
      skipBuild: ctx.raw["skip-build"] === true,
      runtime: ctx.raw.runtime as string | undefined,
      envFile: ctx.raw["env-file"] as string | undefined,
      environment: target.environment,
      log,
      progress,
    });
    // Resolved here, beside the packaging, so a named-but-missing env file
    // fails before anything is provisioned rather than after.
    const env = await resolveEnvFile({
      cwd,
      build: bundle.build,
      environment: target.environment,
      flag: ctx.raw["env-file"] as string | undefined,
      skip: ctx.raw["skip-env"] === true,
      noInput: ctx.flags.noInput || ctx.flags.json,
    });
    const runtime = ctx.raw.runtime ?? bundle.build.runtime;
    if (!runtime) {
      throw new CliError(
        "Pass --runtime (deno|bun|nodejs|nextjs) or set build.runtime in pb.json.",
        2,
      );
    }
    const data: Record<string, unknown> = { project: p.id, runtime };
    if (target.name) data.name = target.name;
    // Backends are Pro-only, and a Pro account's compute is `ownership: "user"`
    // — which the platform's auto-selection, filtered to platform servers,
    // never picks. Without this the deploy lands in the shared pool or fails
    // outright, so the portal names the compute explicitly and so must we.
    // Unset, the compute is chosen on the create path below.
    const compute = computeFlag(ctx.raw);
    if (compute) data.server = compute;
    // An explicit --start wins, then the directory's own start task/script,
    // then the packager (which knows how a Next.js standalone bundle boots).
    const start = ctx.raw.start ?? bundle.build.startCommand ??
      bundle.startCommand;
    if (start) data.startCommand = start;
    // deno/bun/nodejs ship source, so without a start command the platform has
    // nothing to run: it accepts the record and then reports deploymentFailed,
    // leaving a dead backend the user has to find and delete. Refuse up front
    // and say where the command can come from.
    if (!start && !target.id) {
      throw new CliError(
        `No start command for this ${runtime} backend. Add a "start" ` +
          `${
            runtime === "deno" ? "task to deno.json" : "script to package.json"
          }, ` +
          `set build.startCommand in pb.json, or pass --start "<command>".`,
        2,
      );
    }
    attachZip(data, bundle);
    const askCompute = computeChooser(client, p.id, {
      noInput: ctx.flags.noInput || ctx.flags.json,
      log,
    });
    // The archive goes up inside this call, and on a slow link it is by far the
    // longest thing a deploy does without saying anything.
    const { resource, created } = await progress.step(
      uploadLabel(bundle),
      () =>
        deployResource(
          client,
          "backends",
          p.id,
          {
            id: target.id,
            name: target.name,
            data,
            createData: async () => {
              const fields: Record<string, unknown> = {
                user: await resolveOwnerId(client, auth),
                status: "pending",
              };
              // Only on create, and only lazily: a redeploy must never move a
              // running backend to another compute, and asking costs a request.
              if (!data.server) {
                const picked = await askCompute();
                if (picked) fields.server = picked;
              }
              return fields;
            },
            // backend.service.ts only redeploys a record whose status says a
            // new archive is waiting.
            updateData: { status: "uploading" },
            requireExisting: target.fromBinding,
            environment: target.environment,
            onStale: async () => {
              await removeEnvironment(cwd, target.environment);
            },
          },
        ),
    );
    await upsertEnvironment(cwd, {
      projectId: p.id,
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
        deleteMissing: ctx.raw["delete-missing"] === true,
        force: ctx.raw["force-env"] === true,
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
      console.log(JSON.stringify({
        ...final,
        environment: target.environment,
        ...(reachable === undefined ? {} : { reachable }),
      }));
    }
    return final.status === "running" ? 0 : 6;
  };

  const ls: Handler = async (ctx: CmdCtx) => {
    const { client, project: p } = await ctxProject(ctx);
    printResult(await client.listResources("backends", p.id), [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: (r) => r.status },
      { header: "CREATED BY", get: (r) => r.createdBy },
    ], ctx.flags.json);
    return 0;
  };

  async function resolveOne(ctx: CmdCtx) {
    const { client, project: p } = await ctxProject(ctx);
    const base = {
      id: ctx.raw.id as string | undefined,
      name: (ctx.raw.name as string) ?? ctx.args[0],
    };
    const target = await resolveTarget(base, "backends", deps.cwd(), {
      envFlag: ctx.raw.env as string | undefined,
    });
    const found = await resolveExisting(
      await client.listResources("backends", p.id),
      { id: target.id, name: target.name },
      {
        label: "backend",
        interactive: ctx.flags.interactive,
        noInput: ctx.flags.noInput,
      },
    );
    return { client, found, environment: target.environment };
  }

  const info: Handler = async (ctx: CmdCtx) => {
    const { found } = await resolveOne(ctx);
    console.log(JSON.stringify(found, null, 2));
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const { client, found, environment } = await resolveOne(ctx);
    if (
      !await confirm(`Delete backend ${found.name}?`, {
        noInput: ctx.flags.noInput || ctx.flags.json,
        yes: ctx.flags.yes,
      })
    ) {
      console.log("Aborted.");
      return 0;
    }
    await client.updateResource("backends", found.id, { status: "deleted" });
    const removal = await removeEnvironmentFor(
      deps.cwd(),
      environment,
      found.id,
    );
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleting ${found.name}.`,
    );
    if (!ctx.flags.json) reportRemoval(removal, environment, console.log);
    return 0;
  };

  return {
    "cloud backend deploy": deploy,
    "cloud backend ls": ls,
    "cloud backend info": info,
    "cloud backend rm": rm,
  };
}
