import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource } from "../clients/types.ts";
import { CliError, httpError } from "../errors.ts";
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
  reportUrl,
  resolveExisting,
  resolveOwnerId,
  resolveTarget,
  uploadLabel,
  validateLocationChoice,
} from "./deploy-helper.ts";
import { reportRemoval } from "./environments.ts";

export function makeFrontendCommands(
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

  async function requireOne(
    ctx: CmdCtx,
  ): Promise<
    { client: ICloudClient; found: Resource; environment: string }
  > {
    const { client, project: p } = await ctxProject(ctx);
    const base = {
      id: ctx.raw.id as string | undefined,
      name: (ctx.raw.name as string) ?? ctx.args[0],
    };
    const target = await resolveTarget(base, "frontends", deps.cwd(), {
      envFlag: ctx.raw.env as string | undefined,
    });
    const found = await resolveExisting(
      await client.listResources("frontends", p.id),
      { id: target.id, name: target.name },
      {
        label: "frontend",
        interactive: ctx.flags.interactive,
        noInput: ctx.flags.noInput,
      },
    );
    return { client, found, environment: target.environment };
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
      await resolveTarget({ id, name }, "frontends", cwd, {
        envFlag: ctx.raw.env as string | undefined,
        allowNewEnvironment: true,
        strictKind: true,
        askEnvironment: { noInput: ctx.flags.noInput || ctx.flags.json },
      }),
      {
        label: "frontend",
        cwd,
        list: () => client.listResources("frontends", p.id),
        noInput: ctx.flags.noInput || ctx.flags.json,
      },
    );
    const log = (m: string) => progress.log(m);
    const bundle = await buildBundle({
      cwd,
      kind: "frontends",
      zipPath: ctx.raw.zip as string | undefined,
      skipBuild: ctx.raw["skip-build"] === true,
      environment: target.environment,
      log,
      progress,
    });
    if (ctx.raw["env-file"]) {
      throw new CliError(
        "Frontends have no cloud env store — build-time vars are baked into the bundle.",
        2,
      );
    }
    const data: Record<string, unknown> = { project: p.id };
    if (target.name) data.name = target.name;
    if (ctx.raw.location) data.location = ctx.raw.location;
    // A Pro account's dedicated compute is `ownership: "user"`, which the
    // platform's auto-selection (platform servers only) never picks — Pro (and
    // organization) deploys have to name it, exactly as the portal's create
    // page does. Unset, the compute is chosen on the create path below.
    const compute = computeFlag(ctx.raw);
    if (compute) data.server = compute;
    const askCompute = computeChooser(client, p.id, {
      noInput: ctx.flags.noInput || ctx.flags.json,
      log,
    });
    attachZip(data, bundle);

    // No subdomain is sent: the platform assigns
    // `<frontendId>.<compute shortKey>`, served by that compute's wildcard DNS
    // record, so a site costs no DNS record of its own. Use
    // `pb cloud frontend domain` for an address a human types.
    //
    // The archive goes up inside this call — the longest silent stretch of a
    // deploy on a slow link.
    const outcome = await progress.step(
      uploadLabel(bundle),
      () =>
        deployResource(client, "frontends", p.id, {
          id: target.id,
          name: target.name,
          data,
          createData: async () => {
            const fields: Record<string, unknown> = {
              user: await resolveOwnerId(client, auth),
              status: "pending",
            };
            // Only on create: a redeploy must never move a live site to
            // another compute.
            if (!data.server) {
              const picked = await askCompute();
              if (picked) fields.server = picked;
              // `--location` only means anything when the platform
              // auto-selects; refuse one the pool cannot honour.
              else if (ctx.raw.location) {
                await validateLocationChoice(
                  client,
                  p.id,
                  String(ctx.raw.location),
                );
              }
            }
            return fields;
          },
          // frontend.service.ts only redeploys a record whose status says a
          // new archive is waiting.
          updateData: { status: "uploading" },
          requireExisting: target.fromBinding,
          environment: target.environment,
          onStale: async () => {
            await removeEnvironment(cwd, target.environment);
          },
        }),
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
    printResult(await client.listResources("frontends", p.id), [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: (r) => r.status },
      { header: "DOMAIN", get: (r) => r.domain ?? "-" },
      { header: "CREATED BY", get: (r) => r.createdBy },
    ], ctx.flags.json);
    return 0;
  };

  const info: Handler = async (ctx: CmdCtx) => {
    const { found } = await requireOne(ctx);
    console.log(JSON.stringify(found, null, 2));
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const { client, found, environment } = await requireOne(ctx);
    if (
      !await confirm(`Delete frontend ${found.name}?`, {
        noInput: ctx.flags.noInput || ctx.flags.json,
        yes: ctx.flags.yes,
      })
    ) {
      console.log("Aborted.");
      return 0;
    }
    await client.updateResource("frontends", found.id, { status: "deleted" });
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

  function domainHandler(path: string): Handler {
    return async (ctx: CmdCtx) => {
      const domain = ctx.args[0];
      if (!domain) {
        throw new CliError(
          "Usage: pb cloud frontend domain <add|verify|remove> <domain> --name <site>",
          2,
        );
      }
      const { client, found } = await requireOne(ctx);
      const res = await client.ext(path, {
        frontend_id: found.id,
        custom_domain: domain,
      });
      if (!res.ok) {
        // The route's own sentence, not a JSON dump of its whole body.
        throw await httpError(res, `Domain ${path.split("/").pop()}`);
      }
      const body = await res.json().catch(() => ({}));
      console.log(
        ctx.flags.json
          ? JSON.stringify(body)
          : `OK: ${path.split("/").pop()} ${domain}.`,
      );
      return 0;
    };
  }

  return {
    "cloud frontend deploy": deploy,
    "cloud frontend ls": ls,
    "cloud frontend info": info,
    "cloud frontend rm": rm,
    "cloud frontend domain add": domainHandler(
      "/api/frontends/custom-domain/add",
    ),
    "cloud frontend domain verify": domainHandler(
      "/api/frontends/custom-domain/verify",
    ),
    "cloud frontend domain remove": domainHandler(
      "/api/frontends/custom-domain/remove",
    ),
  };
}
