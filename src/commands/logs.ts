import {
  bool,
  type Command,
  defineCommand,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError, httpError } from "../errors.ts";
import { SCHEMA_VERSION } from "../envelope.ts";
import { KINDS, kindByAlias, kindsWith } from "../kinds.ts";
import { readLinkFile } from "../config.ts";
import { resolveResourceTarget } from "../resolve/target.ts";

const LOG_KINDS = kindsWith("logs");
const LOG_NOUNS = LOG_KINDS.map((k) => k.noun);
const LOG_ARG = LOG_NOUNS.join("|");
const DEFAULT_LOG_LINES = 50;
const MAX_LOG_LINES = 1000;
const HISTORY_IDLE_MS = 5_000;

export enum LogReadMode {
  Follow = "follow",
  History = "history",
}

export async function streamToWriter(
  body: ReadableStream<Uint8Array>,
  write: (s: string) => void,
  opts: {
    limit?: number;
    signal?: AbortSignal;
    mode?: LogReadMode;
    idleMs?: number;
  } = {},
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const historyOnly = opts.mode === LogReadMode.History;
  let buffer = "";
  let printed = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  const armIdle = () => {
    if (!historyOnly) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(cancel, opts.idleMs ?? HISTORY_IDLE_MS);
  };
  opts.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (opts.signal?.aborted) return;
    armIdle();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      armIdle();
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        if (historyOnly && isLiveLogEvent(raw)) return;
        const line = decodeLogLine(raw);
        if (line === null) continue;
        write(`${line}\n`);
        if (opts.limit !== undefined && ++printed >= opts.limit) return;
      }
    }
    const last = decodeLogLine(buffer);
    if (last !== null) write(`${last}\n`);
  } finally {
    clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
  }
}

function isLiveLogEvent(raw: string): boolean {
  const line = raw.trim().replace(/^data:/, "").trim();
  if (!line.startsWith("{")) return false;
  try {
    return (JSON.parse(line) as { type?: string }).type === "new";
  } catch {
    return false;
  }
}

export function parseLogLines(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LOG_LINES;
  const lines = Number(value);
  if (
    value.trim() === "" || !Number.isInteger(lines) || lines < 1 ||
    lines > MAX_LOG_LINES
  ) {
    throw new CliError(
      `--lines must be a whole number from 1 to ${MAX_LOG_LINES}, got "${value}".`,
      { code: "USAGE" },
    );
  }
  return lines;
}

const DEPLOY_LOG_LINES = 50;
const DEPLOY_LOG_TIMEOUT_MS = 5_000;

export async function reportDeploymentLogs(
  client: ICloudClient,
  opts: {
    type: "pocketbase" | "backend";
    targetId: string;
    log: (message: string) => void;
    timeoutMs?: number;
  },
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEPLOY_LOG_TIMEOUT_MS,
  );
  const follow = `pbc logs ${opts.type} --id ${opts.targetId} --follow`;
  let printed = false;
  opts.log(`Recent logs (${DEPLOY_LOG_LINES} lines max):`);
  try {
    const res = await client.ext("/api/logs/stream", {
      target_id: opts.targetId,
      type: opts.type,
      initial_lines: DEPLOY_LOG_LINES,
      follow: false,
    }, { signal: controller.signal });
    if (!res.ok || !res.body) throw await httpError(res, "Log stream");
    await streamToWriter(res.body, (line) => {
      printed = true;
      opts.log(line.replace(/\n$/, ""));
    }, {
      limit: DEPLOY_LOG_LINES,
      signal: controller.signal,
      mode: LogReadMode.History,
    });
    if (!printed) opts.log("No logs available yet.");
  } catch (error) {
    if (!controller.signal.aborted) {
      opts.log(
        `Could not read logs: ${error instanceof Error ? error.message : String(error)}`,
      );
    } else if (!printed) {
      opts.log("No logs available yet.");
    }
  } finally {
    clearTimeout(timer);
  }
  opts.log(`Follow logs: ${follow}`);
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
        `pbc logs [${LOG_ARG}] --name <n> [-f] [--lines <n>] [--env <name>]`,
      summary: "Stream logs for a PocketBase instance or service.",
      details: `Prints the last --lines entries (50 by default, 1000 max) and stops; with
--follow it keeps printing until interrupted. The kind defaults to the one
pbc.json is bound to.`,
      args: [{ name: LOG_ARG, required: false }],
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
        const bound = (await readLinkFile(deps.cwd()))?.kind;
        const spec = ctx.args[0]
          ? kindByAlias(ctx.args[0])
          : bound
          ? KINDS[bound]
          : null;
        if (ctx.args[0] && !spec) {
          const hinted = bound && KINDS[bound].logs
            ? KINDS[bound]
            : LOG_KINDS[0];
          throw new CliError(
            `The first argument is the kind (${LOG_ARG}), not a name. ` +
              `Did you mean \`pbc logs ${hinted.noun} --name ${ctx.args[0]}\`?`,
            { code: "USAGE" },
          );
        }
        if (!spec || !spec.logs) {
          throw new CliError(
            `Usage: pbc logs <${LOG_ARG}> --name <n> [-f]`,
            { code: "USAGE" });
        }
        const type = spec.apiType!;
        const lines = parseLogLines(input.lines);
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
        const res = await client.ext("/api/logs/stream", {
          target_id: found.id,
          type,
          initial_lines: lines,
          follow,
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
          follow ? {} : { limit: lines, mode: LogReadMode.History },
        );
        return 0;
      },
    }),
  };
}
