import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { CliError } from "../errors.ts";
import { resolveProject } from "../resolve/project.ts";
import { join } from "@std/path";

export function makeDataCommands(deps: CloudCmdDeps): Record<string, Handler> {
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

  const exportCmd: Handler = async (ctx: CmdCtx) => {
    const { client, project: p } = await project(ctx);
    const out = (ctx.raw.out as string) ?? join(deps.cwd(), "export.zip");
    const res = await client.ext("/api/projects/export", { projectId: p.id });
    if (!res.ok) throw new CliError(`Export failed (${res.status}).`, 1);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await Deno.writeFile(out, bytes);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ out, bytes: bytes.length })
        : `Exported to ${out}.`,
    );
    return 0;
  };

  const importCmd: Handler = async (ctx: CmdCtx) => {
    const file = ctx.args[0];
    if (!file) throw new CliError("Usage: pb cloud data import <file.zip>", 2);
    const { client, project: p } = await project(ctx);
    const data = await Deno.readFile(file);
    const b64 = btoa(String.fromCharCode(...data));
    const res = await client.ext("/api/projects/import", {
      projectId: p.id,
      data: b64,
    });
    if (!res.ok) throw new CliError(`Import failed (${res.status}).`, 1);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Imported ${file}.`,
    );
    return 0;
  };

  return { "cloud data export": exportCmd, "cloud data import": importCmd };
}
