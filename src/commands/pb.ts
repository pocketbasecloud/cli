import { join } from "@std/path";
import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError } from "../errors.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";
import type { BuildConfig } from "../config.ts";
import {
  removeEnvironment,
  removeEnvironmentFor,
  upsertEnvironment,
} from "../config.ts";
import { resolveBuildConfig } from "../build/config.ts";
import {
  attachZip,
  buildBundle,
  deployResource,
  missingTargetMessage,
  pollStatus,
  pushEnvFile,
  resolveExisting,
  resolveTarget,
} from "./deploy-helper.ts";
import { reportRemoval } from "./environments.ts";

/**
 * Uploads every *.pb.js in `dir` and returns how many were sent. Shared by
 * `hooks push` and by `deploy`'s redeploy path, which is the only way a running
 * instance can be updated — its archive is read once, at creation.
 */
export async function pushHooks(
  client: ICloudClient,
  projectId: string,
  dir: string,
): Promise<number> {
  const files: { filename: string; content: string }[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".pb.js")) {
        files.push({
          filename: entry.name,
          content: await Deno.readTextFile(join(dir, entry.name)),
        });
      }
    }
  } catch {
    throw new CliError(`Hooks directory not found: ${dir}`, 2);
  }
  if (files.length === 0) return 0;
  const res = await client.ext("/api/hooks/bulk-write", {
    project: projectId,
    files,
  });
  if (!res.ok) throw new CliError(`Hook push failed (${res.status}).`, 1);
  return files.length;
}

export function makePbCommands(deps: CloudCmdDeps): Record<string, Handler> {
  async function project(ctx: CmdCtx) {
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
    const { client, project: p } = await project(ctx);
    const cwd = deps.cwd();
    const name = (ctx.raw.name as string) ?? ctx.args[0];
    const id = ctx.raw.id as string | undefined;
    const target = await resolveTarget({ id, name }, "pocketbases", cwd, {
      envFlag: ctx.raw.env as string | undefined,
      allowNewEnvironment: true,
      strictKind: true,
    });
    if (!target.id && !target.name) {
      throw new CliError(missingTargetMessage(target, "PocketBase"), 2);
    }
    const log = ctx.flags.json ? () => {} : (m: string) => console.log(m);
    const zipPath = ctx.raw.zip as string | undefined;
    const data: Record<string, unknown> = { project: p.id };
    if (name) data.name = name;
    if (ctx.raw.location) data.location = ctx.raw.location;
    if (ctx.raw.server) data.server = ctx.raw.server;

    // The platform passes zip_url to the agent only from createPBInstance, so
    // the archive is built on the create path and nowhere else.
    let build: BuildConfig = {};
    const { resource, created } = await deployResource(
      client,
      "pocketbases",
      p.id,
      {
        id: target.id,
        name: target.name,
        data,
        createData: async () => {
          const bundle = await buildBundle({
            cwd,
            kind: "pocketbases",
            zipPath,
            skipBuild: ctx.raw["skip-build"] === true,
            envFile: ctx.raw["env-file"] as string | undefined,
            environment: target.environment,
            log,
          });
          build = bundle.build;
          const extra: Record<string, unknown> = {};
          attachZip(extra, bundle);
          return extra;
        },
        requireExisting: target.fromBinding,
        environment: target.environment,
        onStale: async () => {
          await removeEnvironment(cwd, target.environment);
        },
      },
    );
    await upsertEnvironment(cwd, {
      projectId: p.id,
      kind: "pocketbases",
      environment: target.environment,
      entry: { id: resource.id, name: resource.name },
    });

    if (!created) {
      if (zipPath) {
        throw new CliError(
          "--zip cannot be applied to an existing PocketBase — the platform " +
            "reads the archive only when the instance is created.",
          2,
        );
      }
      build = await resolveBuildConfig({
        cwd,
        kind: "pocketbases",
        flags: { envFile: ctx.raw["env-file"] as string | undefined },
        environment: target.environment,
        log,
      });
      if (build.pbHooks) {
        const n = await pushHooks(client, p.id, join(cwd, build.pbHooks));
        log(`Pushed ${n} hook file(s).`);
      }
      log(
        "Note: pb_public and pb_migrations were not applied. The platform " +
          "extracts a PocketBase archive only when the instance is created.",
      );
    }

    if (ctx.raw["skip-env"] !== true) {
      await pushEnvFile(client, {
        targetId: resource.id,
        type: "pocketbase",
        cwd,
        build,
        explicit: ctx.raw["env-file"] !== undefined,
        log,
      });
    }
    if (!ctx.flags.json) {
      console.log(
        `${created ? "Creating" : "Redeploying"} ${resource.name} ` +
          `(environment: ${target.environment})…`,
      );
    }
    const final = await pollStatus(client, "pocketbases", resource.id, {
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
    const { client, project: p } = await project(ctx);
    const rows = await client.listResources("pocketbases", p.id);
    printResult(rows, [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: (r) => r.status },
      { header: "DOMAIN", get: (r) => r.domain ?? r.subdomain ?? "-" },
      { header: "CREATED BY", get: (r) => r.createdBy },
    ], ctx.flags.json);
    return 0;
  };

  async function resolveOne(ctx: CmdCtx) {
    const { client, project: p } = await project(ctx);
    const base = {
      id: ctx.raw.id as string | undefined,
      name: (ctx.raw.name as string) ?? ctx.args[0],
    };
    const target = await resolveTarget(base, "pocketbases", deps.cwd(), {
      envFlag: ctx.raw.env as string | undefined,
    });
    const found = await resolveExisting(
      await client.listResources("pocketbases", p.id),
      { id: target.id, name: target.name },
      {
        label: "PocketBase",
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
      !await confirm(`Delete PocketBase ${found.name}?`, {
        noInput: ctx.flags.noInput,
        yes: ctx.flags.yes,
      })
    ) {
      console.log("Aborted.");
      return 0;
    }
    // Deletion is an update to status="deleted", which triggers teardown via hooks.
    await client.updateResource("pocketbases", found.id, { status: "deleted" });
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

  const hooksPush: Handler = async (ctx: CmdCtx) => {
    const dir = ctx.args[0];
    if (!dir) throw new CliError("Usage: pb cloud pb hooks push <dir>", 2);
    const { client, project: p } = await project(ctx);
    const pushed = await pushHooks(client, p.id, dir);
    if (pushed === 0) throw new CliError(`No *.pb.js files in ${dir}.`, 2);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ pushed })
        : `Pushed ${pushed} hook file(s).`,
    );
    return 0;
  };

  const hooksLs: Handler = async (ctx: CmdCtx) => {
    const { client, project: p } = await project(ctx);
    const res = await client.ext("/api/hooks", { project: p.id });
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
    return 0;
  };

  const hooksRm: Handler = async (ctx: CmdCtx) => {
    const filename = ctx.args[0];
    if (!filename) {
      throw new CliError("Usage: pb cloud pb hooks rm <filename>", 2);
    }
    const { client, project: p } = await project(ctx);
    const res = await client.ext("/api/hooks/delete", {
      project: p.id,
      filename,
    });
    if (!res.ok) throw new CliError(`Hook delete failed (${res.status}).`, 1);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleted ${filename}.`,
    );
    return 0;
  };

  return {
    "cloud pb deploy": deploy,
    "cloud pb ls": ls,
    "cloud pb info": info,
    "cloud pb rm": rm,
    "cloud pb hooks push": hooksPush,
    "cloud pb hooks ls": hooksLs,
    "cloud pb hooks rm": hooksRm,
  };
}
