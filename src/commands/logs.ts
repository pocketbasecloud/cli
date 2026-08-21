import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ResourceKind } from "../clients/types.ts";
import { CliError, httpError } from "../errors.ts";
import { resolveProject } from "../resolve/project.ts";
import { resolveExisting, resolveTarget } from "./deploy-helper.ts";

/**
 * The route answers with Server-Sent Events — `data: {"line": "..."}` frames,
 * one per log line — and never ends on its own, since it tails the container.
 * So the payload is unwrapped here, and without `--follow` the reader stops
 * once the requested backlog has been printed.
 */
export async function streamToWriter(
  body: ReadableStream<Uint8Array>,
  write: (s: string) => void,
  opts: { limit?: number } = {},
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  let printed = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = decodeLogLine(raw);
        if (line === null) continue;
        write(`${line}\n`);
        if (opts.limit !== undefined && ++printed >= opts.limit) return;
      }
    }
    const last = decodeLogLine(buffer);
    if (last !== null) write(`${last}\n`);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** One SSE line -> the text to print, or null for framing/keep-alives. */
export function decodeLogLine(raw: string): string | null {
  let line = raw.trim();
  if (line.length === 0) return null;
  if (line.startsWith("data:")) line = line.slice(5).trim();
  if (line.length === 0) return null;
  if (!line.startsWith("{")) return line;
  try {
    const ev = JSON.parse(line) as {
      line?: string;
      message?: string;
      type?: string;
    };
    const text = ev.line ?? ev.message;
    if (text === undefined) return null;
    return ev.type === "error" ? `Error: ${text}` : text;
  } catch {
    return line; // Not JSON after all — show it rather than swallow it.
  }
}

export function makeLogsCommands(deps: CloudCmdDeps): Record<string, Handler> {
  const logs: Handler = async (ctx: CmdCtx) => {
    const which = ctx.args[0];
    if (which !== "pb" && which !== "backend") {
      throw new CliError(
        "Usage: pbc cloud logs <pb|backend> --name <n> [-f]",
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
      noInput: ctx.flags.noInput || ctx.flags.json,
      log: ctx.flags.json ? undefined : (m) => console.log(m),
    });
    const target = await resolveTarget(
      {
        id: ctx.raw.id as string | undefined,
        name: ctx.raw.name as string | undefined,
      },
      kind,
      deps.cwd(),
      { envFlag: ctx.raw.env as string | undefined },
    );
    const found = await resolveExisting(
      await client.listResources(kind, p.id),
      { id: target.id, name: target.name },
      {
        label: which === "pb" ? "PocketBase" : "backend",
        noInput: ctx.flags.noInput || ctx.flags.json,
      },
    );
    const follow = ctx.raw.follow === true;
    const lines = Math.min(
      Math.max(Number(ctx.raw.lines ?? 50) || 50, 1),
      1000,
    );
    const res = await client.ext("/api/logs/stream", {
      target_id: found.id,
      type,
      initial_lines: lines,
    });
    if (!res.ok || !res.body) {
      throw await httpError(res, "Log stream");
    }
    await streamToWriter(
      res.body,
      (s) => Deno.stdout.writeSync(new TextEncoder().encode(s)),
      follow ? {} : { limit: lines },
    );
    return 0;
  };
  return { "cloud logs": logs };
}
