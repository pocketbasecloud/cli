import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { CliError } from "../errors.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";
import { clearResourceLink, upsertResourceLink } from "../config.ts";
import {
  deployResource,
  pollStatus,
  resolveExisting,
  resolveTargetToken,
} from "./deploy-helper.ts";

export function makeBackendCommands(
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

  const deploy: Handler = async (ctx: CmdCtx) => {
    const { client, project: p } = await ctxProject(ctx);
    const cwd = deps.cwd();
    const name = (ctx.raw.name as string) ?? ctx.args[0];
    const id = ctx.raw.id as string | undefined;
    const target = await resolveTargetToken({ id, name }, "backends", cwd);
    if (!target.id && !target.name) {
      throw new CliError("Pass --name to create the first backend.", 2);
    }
    const data: Record<string, unknown> = { project: p.id };
    if (name) data.name = name;
    if (ctx.raw.runtime) data.runtime = ctx.raw.runtime;
    if (ctx.raw.start) data.startCommand = ctx.raw.start;
    if (ctx.raw.zip) data.zipFile = ctx.raw.zip;
    const { resource, created } = await deployResource(
      client,
      "backends",
      p.id,
      {
        id: target.id,
        name: target.name,
        data,
        requireExisting: target.fromBinding,
        onStale: () => clearResourceLink(cwd),
      },
    );
    await upsertResourceLink(cwd, p.id, {
      kind: "backends",
      id: resource.id,
      name: resource.name,
    });
    if (!ctx.flags.json) {
      console.log(`${created ? "Creating" : "Redeploying"} ${resource.name}…`);
    }
    const final = await pollStatus(client, "backends", resource.id, {
      terminal: ["running", "error", "failed"],
      timeoutMs: 300_000,
      intervalMs: 3_000,
      onTick: ctx.flags.json ? undefined : (s) => console.log(`  status: ${s}`),
    });
    console.log(
      ctx.flags.json
        ? JSON.stringify(final)
        : `Done: ${final.name} is ${final.status}.`,
    );
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
    const target = await resolveTargetToken(base, "backends", deps.cwd());
    const found = await resolveExisting(
      await client.listResources("backends", p.id),
      { id: target.id, name: target.name },
      {
        label: "backend",
        interactive: ctx.flags.interactive,
        noInput: ctx.flags.noInput,
      },
    );
    return { client, found };
  }

  const info: Handler = async (ctx: CmdCtx) => {
    const { found } = await resolveOne(ctx);
    console.log(JSON.stringify(found, null, 2));
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const { client, found } = await resolveOne(ctx);
    if (
      !await confirm(`Delete backend ${found.name}?`, {
        noInput: ctx.flags.noInput,
        yes: ctx.flags.yes,
      })
    ) {
      console.log("Aborted.");
      return 0;
    }
    await client.updateResource("backends", found.id, { status: "deleted" });
    await clearResourceLink(deps.cwd());
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleting ${found.name}.`,
    );
    return 0;
  };

  return {
    "cloud backend deploy": deploy,
    "cloud backend ls": ls,
    "cloud backend info": info,
    "cloud backend rm": rm,
  };
}
