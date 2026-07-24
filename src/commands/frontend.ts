import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource } from "../clients/types.ts";
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
  buildBundle,
  deployResource,
  missingTargetMessage,
  pollStatus,
  resolveExisting,
  resolveTarget,
} from "./deploy-helper.ts";
import { reportRemoval } from "./environments.ts";

export function makeFrontendCommands(
  deps: CloudCmdDeps,
): Record<string, Handler> {
  async function ctxProject(ctx: CmdCtx) {
    const { client, config } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput,
    });
    return { client, project: p };
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
    const { client, project: p } = await ctxProject(ctx);
    const cwd = deps.cwd();
    const name = (ctx.raw.name as string) ?? ctx.args[0];
    const id = ctx.raw.id as string | undefined;
    const target = await resolveTarget({ id, name }, "frontends", cwd, {
      envFlag: ctx.raw.env as string | undefined,
      allowNewEnvironment: true,
      strictKind: true,
    });
    if (!target.id && !target.name) {
      throw new CliError(missingTargetMessage(target, "frontend"), 2);
    }
    const log = ctx.flags.json ? () => {} : (m: string) => console.log(m);
    const bundle = await buildBundle({
      cwd,
      kind: "frontends",
      zipPath: ctx.raw.zip as string | undefined,
      skipBuild: ctx.raw["skip-build"] === true,
      environment: target.environment,
      log,
    });
    if (ctx.raw["env-file"]) {
      throw new CliError(
        "Frontends have no cloud env store — build-time vars are baked into the bundle.",
        2,
      );
    }
    const data: Record<string, unknown> = { project: p.id };
    if (name) data.name = name;
    if (ctx.raw.location) data.location = ctx.raw.location;
    attachZip(data, bundle);
    const { resource, created } = await deployResource(
      client,
      "frontends",
      p.id,
      {
        id: target.id,
        name: target.name,
        data,
        // frontend.service.ts only redeploys a record whose status says a new
        // archive is waiting.
        updateData: { status: "uploading" },
        requireExisting: target.fromBinding,
        environment: target.environment,
        onStale: async () => {
          await removeEnvironment(cwd, target.environment);
        },
      },
    );
    await upsertEnvironment(cwd, {
      projectId: p.id,
      kind: "frontends",
      environment: target.environment,
      entry: { id: resource.id, name: resource.name },
    });
    if (!ctx.flags.json) {
      console.log(
        `${created ? "Creating" : "Redeploying"} ${resource.name} ` +
          `(environment: ${target.environment})…`,
      );
    }
    const final = await pollStatus(client, "frontends", resource.id, {
      terminal: ["running", "error", "failed"],
      timeoutMs: 300_000,
      intervalMs: 3_000,
      onTick: ctx.flags.json ? undefined : (s) => console.log(`  status: ${s}`),
    });
    console.log(
      ctx.flags.json
        ? JSON.stringify({ ...final, environment: target.environment })
        : `Done: ${final.name} is ${final.status}.`,
    );
    return final.status === "running" ? 0 : 6;
  };

  const ls: Handler = async (ctx: CmdCtx) => {
    const { client, project: p } = await ctxProject(ctx);
    printResult(await client.listResources("frontends", p.id), [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: (r) => r.status },
      { header: "DOMAIN", get: (r) => r.domain ?? r.subdomain ?? "-" },
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
        noInput: ctx.flags.noInput,
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
      const res = await client.ext(path, { frontendId: found.id, domain });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new CliError(
          `Domain op failed (${res.status}): ${JSON.stringify(body)}`,
          1,
        );
      }
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
