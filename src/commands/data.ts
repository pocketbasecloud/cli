import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { CliError } from "../errors.ts";
import { resolveProject } from "../resolve/project.ts";
import { resolveExisting, resolveTarget } from "./deploy-helper.ts";
import { join } from "@std/path";

/**
 * The export route answers with JSON describing a file PocketBase now holds —
 * not with the archive itself. The archive is fetched separately, with a
 * short-lived file token.
 */
export type ExportResponse = {
  success?: boolean;
  downloadUrl?: string;
  fileName?: string;
  error?: string;
  error_message?: string;
};

/** The platform builds this URL with one slash after the scheme. */
export function normalizeDownloadUrl(url: string): string {
  return url.replace(/^(https?):\/([^/])/, "$1://$2");
}

export function makeDataCommands(deps: CloudCmdDeps): Record<string, Handler> {
  /** Export acts on one PocketBase instance, not on the project. */
  async function resolveInstance(ctx: CmdCtx) {
    const { client, config } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput || ctx.flags.json,
      log: ctx.flags.json ? undefined : (m) => console.log(m),
    });
    const target = await resolveTarget(
      {
        id: ctx.raw.id as string | undefined,
        name: ctx.raw.name as string | undefined,
      },
      "pocketbases",
      deps.cwd(),
      { envFlag: ctx.raw.env as string | undefined },
    );
    const found = await resolveExisting(
      await client.listResources("pocketbases", p.id),
      { id: target.id, name: target.name },
      {
        label: "PocketBase",
        interactive: ctx.flags.interactive,
        noInput: ctx.flags.noInput,
      },
    );
    return { client, found };
  }

  const exportCmd: Handler = async (ctx: CmdCtx) => {
    const { client, found } = await resolveInstance(ctx);
    const res = await client.ext("/api/projects/export", {
      projectId: found.id,
    });
    const body = await res.json().catch(() => ({})) as ExportResponse;
    const reason = body.error_message ?? body.error;
    if (!res.ok || !body.success || !body.downloadUrl) {
      throw new CliError(
        `Export failed (${res.status})${reason ? `: ${reason}` : ""}.`,
        1,
      );
    }
    const token = await client.fileToken();
    const file = await fetch(
      `${normalizeDownloadUrl(body.downloadUrl)}?token=${token}`,
    );
    if (!file.ok) throw new CliError(`Download failed (${file.status}).`, 1);
    const out = (ctx.raw.out as string) ??
      join(deps.cwd(), body.fileName ?? "export.zip");
    const bytes = new Uint8Array(await file.arrayBuffer());
    await Deno.writeFile(out, bytes);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ out, bytes: bytes.length })
        : `Exported to ${out}.`,
    );
    return 0;
  };

  // The platform's import route takes a CSV/JSON file plus a target collection
  // and a per-field mapping, as multipart form data — none of which this
  // command has a way to ask for. It never worked against that route, and
  // guessing a mapping would write the wrong data into someone's collection.
  const importCmd: Handler = () => {
    return Promise.reject(
      new CliError(
        "`pb cloud data import` is not implemented — the platform's import " +
          "needs a target collection and a field mapping. Use the portal's " +
          "import dialog.",
        2,
      ),
    );
  };

  return { "cloud data export": exportCmd, "cloud data import": importCmd };
}
