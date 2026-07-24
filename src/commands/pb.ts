import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { CliError } from "../errors.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";
import {
  deployResource,
  pollStatus,
  resolveExisting,
} from "./deploy-helper.ts";

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
    const name = (ctx.raw.name as string) ?? ctx.args[0];
    const id = ctx.raw.id as string | undefined;
    if (!name && !id) {
      throw new CliError(
        "Usage: pb cloud pb deploy --name <name> [--location <loc>] [--server <id>]",
        2,
      );
    }
    const data: Record<string, unknown> = { project: p.id };
    if (name) data.name = name;
    if (ctx.raw.location) data.location = ctx.raw.location;
    if (ctx.raw.server) data.server = ctx.raw.server;
    const { resource, created } = await deployResource(
      client,
      "pocketbases",
      p.id,
      {
        id,
        name,
        data,
      },
    );
    if (!ctx.flags.json) {
      console.log(`${created ? "Creating" : "Redeploying"} ${resource.name}…`);
    }
    const final = await pollStatus(client, "pocketbases", resource.id, {
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

  const info: Handler = async (ctx: CmdCtx) => {
    const { client, project: p } = await project(ctx);
    const token = {
      id: ctx.raw.id as string | undefined,
      name: (ctx.raw.name as string) ?? ctx.args[0],
    };
    const found = await resolveExisting(
      await client.listResources("pocketbases", p.id),
      token,
      {
        label: "PocketBase",
        interactive: ctx.flags.interactive,
        noInput: ctx.flags.noInput,
      },
    );
    console.log(JSON.stringify(found, null, 2));
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const { client, project: p } = await project(ctx);
    const token = {
      id: ctx.raw.id as string | undefined,
      name: (ctx.raw.name as string) ?? ctx.args[0],
    };
    const found = await resolveExisting(
      await client.listResources("pocketbases", p.id),
      token,
      {
        label: "PocketBase",
        interactive: ctx.flags.interactive,
        noInput: ctx.flags.noInput,
      },
    );
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
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleting ${found.name}.`,
    );
    return 0;
  };

  const hooksPush: Handler = async (ctx: CmdCtx) => {
    const dir = ctx.args[0];
    if (!dir) throw new CliError("Usage: pb cloud pb hooks push <dir>", 2);
    const { client, project: p } = await project(ctx);
    const files: { filename: string; content: string }[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".pb.js")) {
        files.push({
          filename: entry.name,
          content: await Deno.readTextFile(`${dir}/${entry.name}`),
        });
      }
    }
    if (files.length === 0) {
      throw new CliError(`No *.pb.js files in ${dir}.`, 2);
    }
    const res = await client.ext("/api/hooks/bulk-write", {
      project: p.id,
      files,
    });
    if (!res.ok) throw new CliError(`Hook push failed (${res.status}).`, 1);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ pushed: files.length })
        : `Pushed ${files.length} hook file(s).`,
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
