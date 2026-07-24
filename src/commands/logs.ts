import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ResourceKind } from "../clients/types.ts";
import { CliError } from "../errors.ts";
import { resolveProject } from "../resolve/project.ts";
import { findExisting } from "./deploy-helper.ts";

export async function streamToWriter(
  body: ReadableStream<Uint8Array>,
  write: (s: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) write(dec.decode(value, { stream: true }));
  }
}

export function makeLogsCommands(deps: CloudCmdDeps): Record<string, Handler> {
  const logs: Handler = async (ctx: CmdCtx) => {
    const which = ctx.args[0];
    if (which !== "pb" && which !== "backend") {
      throw new CliError(
        "Usage: pb cloud logs <pb|backend> --name <n> [-f]",
        2,
      );
    }
    const kind: ResourceKind = which === "pb" ? "pocketbases" : "backends";
    const type = which === "pb" ? "pocketbase" : "backend";
    const { client, config } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput,
    });
    const token = {
      id: ctx.raw.id as string | undefined,
      name: ctx.raw.name as string | undefined,
    };
    const found = findExisting(await client.listResources(kind, p.id), token);
    if (!found || found === "ambiguous") {
      throw new CliError("Specify a unique --name or --id.", 2);
    }
    const follow = ctx.raw.follow === true;
    const res = await client.ext("/api/logs/stream", {
      targetId: found.id,
      type,
      follow,
    });
    if (!res.ok || !res.body) {
      throw new CliError(`Log stream failed (${res.status}).`, 1);
    }
    await streamToWriter(
      res.body,
      (s) => Deno.stdout.writeSync(new TextEncoder().encode(s)),
    );
    return 0;
  };
  return { "cloud logs": logs };
}
