import {
  bool,
  type Command,
  defineCommand,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import { CliError, httpError } from "../errors.ts";
import { SCHEMA_VERSION } from "../envelope.ts";
import { kindByAlias, kindsWith } from "../kinds.ts";
import { resolveResourceTarget } from "../resolve/target.ts";

const LOG_KINDS = kindsWith("logs");
const LOG_NOUNS = LOG_KINDS.map((k) => k.noun);
const LOG_ARG = LOG_NOUNS.join("|");

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
    return line;
  }
}

export function makeLogsCommands(deps: CloudCmdDeps): Record<string, Command> {
  return {
    "logs": defineCommand({
      path: ["logs"],
      usage:
        `pbc logs <${LOG_ARG}> --name <n> [-f] [--lines <n>] [--env <name>]`,
      summary: "Stream logs for a PocketBase instance or backend.",
      details: `Prints the last --lines entries (50 by default, 1000 max) and stops. With
--follow it keeps printing until interrupted, since the platform tails the
container for as long as the connection is open.

Without --name/--id, a terminal offers a picker.`,
      args: [{ name: LOG_ARG, required: true }],
      flags: {
        name: str({
          description: "Which instance's logs. Asked for when omitted.",
          required: true,
        }),
        id: str({ description: "The instance's id, alternative to --name." }),
        env: str({ description: "Which pbc.json environment to target." }),
        follow: bool({
          description: "Keep printing as new log lines arrive.",
          short: "f",
        }),
        lines: str({
          description: "How much history to print first. 1-1000, default 50.",
        }),
      },
      run: async (input, ctx) => {
        const spec = kindByAlias(ctx.args[0] ?? "");
        if (!spec || !spec.logs) {
          throw new CliError(
            `Usage: pbc logs <${LOG_ARG}> --name <n> [-f]`,
            { code: "USAGE" });
        }
        const type = spec.apiType!;
        const { client, config } = await deps.requireAuth();
        const { resource: found } = await resolveResourceTarget({
          client,
          spec,
          cwd: deps.cwd(),
          name: input.name,
          id: input.id,
          envFlag: input.env,
          projectFilter: ctx.flags.project,
          config,
          explicit: false,
          noInput: ctx.flags.noInput || ctx.flags.json,
          io: deps.io,
          log: (m) => console.error(m),
        });
        const follow = input.follow === true;
        const lines = Math.min(
          Math.max(Number(input.lines ?? 50) || 50, 1),
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
        const rawWrite = (s: string) =>
          Deno.stdout.writeSync(new TextEncoder().encode(s));
        const write = ctx.flags.json
          ? (raw: string) =>
            rawWrite(
              JSON.stringify({
                ok: true,
                schemaVersion: SCHEMA_VERSION,
                data: { line: raw.replace(/\n$/, "") },
              }) + "\n",
            )
          : rawWrite;
        await streamToWriter(
          res.body,
          write,
          follow ? {} : { limit: lines },
        );
        return 0;
      },
    }),
  };
}
