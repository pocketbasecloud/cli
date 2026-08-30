export type Step = {
  update(text: string): void;
  done(text?: string): void;
  fail(text?: string): void;
};

export type Progress = {
  log(text: string): void;
  start(text: string, opts?: StepOptions): Step;
  step<T>(
    text: string,
    fn: (step: Step) => Promise<T>,
    opts?: StepOptions,
  ): Promise<T>;
};

export type StepOptions = {
  animate?: boolean;
};

export type Ticker = { stop: () => void };

export type ProgressOptions = {
  write?: (s: string) => void;
  animate?: boolean;
  silent?: boolean;
  now?: () => number;
  columns?: () => number;
  schedule?: (tick: () => void, intervalMs: number) => Ticker;
  unicode?: boolean;
  intervalMs?: number;
};

const FRAMES_UNICODE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAMES_ASCII = ["|", "/", "-", "\\"];
const MARKS_UNICODE = { done: "✓", fail: "✗", pending: "→" };
const MARKS_ASCII = { done: "+", fail: "x", pending: ">" };

const ENCODER = new TextEncoder();

export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

export function renderLine(
  mark: string,
  text: string,
  elapsedMs: number,
  columns = 80,
): string {
  const suffix = elapsedMs >= 1000 ? ` ${formatElapsed(elapsedMs)}` : "";
  const line = `${mark} ${text}${suffix}`;
  const limit = Math.max(columns - 1, 20);
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function terminalColumns(): number {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return 80;
  }
}

function stderrIsTerminal(): boolean {
  try {
    return Deno.stderr.isTerminal();
  } catch {
    return false;
  }
}

function supportsUnicode(): boolean {
  if (Deno.build.os !== "windows") return true;
  return Boolean(Deno.env.get("WT_SESSION"));
}

const defaultSchedule = (tick: () => void, intervalMs: number): Ticker => {
  const id = setInterval(tick, intervalMs);
  Deno.unrefTimer(id);
  return { stop: () => clearInterval(id) };
};

let live: { suspend: () => void; resume: () => void } | null = null;

export async function pauseProgress<T>(fn: () => Promise<T>): Promise<T> {
  const held = live;
  held?.suspend();
  try {
    return await fn();
  } finally {
    held?.resume();
  }
}

export function createProgress(opts: ProgressOptions = {}): Progress {
  const silent = opts.silent ?? false;
  const write = opts.write ??
    ((s: string) => {
      Deno.stderr.writeSync(ENCODER.encode(s));
    });
  const animate = silent ? false : (opts.animate ?? stderrIsTerminal());
  const unicode = opts.unicode ?? supportsUnicode();
  const now = opts.now ?? (() => Date.now());
  const columns = opts.columns ?? terminalColumns;
  const schedule = opts.schedule ?? defaultSchedule;
  const intervalMs = opts.intervalMs ?? 80;
  const frames = unicode ? FRAMES_UNICODE : FRAMES_ASCII;
  const marks = unicode ? MARKS_UNICODE : MARKS_ASCII;

  let current:
    | { text: string; startedAt: number; frame: number; ticker: Ticker | null }
    | null = null;

  const clearLine = () => write("\r\x1b[2K");

  const draw = () => {
    if (!current) return;
    clearLine();
    write(renderLine(
      frames[current.frame % frames.length],
      current.text,
      now() - current.startedAt,
      columns(),
    ));
  };

  const suspend = () => {
    if (!current) return;
    current.ticker?.stop();
    current.ticker = null;
    clearLine();
  };

  const resume = () => {
    if (!current || current.ticker) return;
    current.ticker = schedule(() => {
      if (!current) return;
      current.frame++;
      draw();
    }, intervalMs);
    draw();
  };

  const line = (s: string) => write(`${s}\n`);

  function log(text: string): void {
    if (silent) return;
    const wasLive = current !== null && current.ticker !== null;
    if (current) suspend();
    line(text);
    if (wasLive) resume();
  }

  function start(text: string, stepOpts: StepOptions = {}): Step {
    if (silent) return SILENT_STEP;
    const startedAt = now();
    const animated = animate && (stepOpts.animate ?? true);
    let closed = false;

    if (!animated) {
      line(renderLine(marks.pending, `${text}…`, 0, columns()));
    }

    const state = { text, startedAt, frame: 0, ticker: null as Ticker | null };
    if (animated) {
      suspend();
      current = state;
      live = { suspend, resume };
      resume();
    }

    const close = (mark: string, closingText?: string) => {
      if (closed) return;
      closed = true;
      if (closingText !== undefined) state.text = closingText;
      if (animated && current === state) {
        suspend();
        current = null;
        live = null;
      }
      line(renderLine(mark, state.text, now() - startedAt, columns()));
    };

    return {
      update: (text: string) => {
        if (closed) return;
        const changed = text !== state.text;
        state.text = text;
        if (animated) {
          if (current === state) draw();
        } else if (changed) {
          line(
            renderLine(marks.pending, `${text}…`, now() - startedAt, columns()),
          );
        }
      },
      done: (text?: string) => close(marks.done, text),
      fail: (text?: string) => close(marks.fail, text),
    };
  }

  async function step<T>(
    text: string,
    fn: (step: Step) => Promise<T>,
    stepOpts: StepOptions = {},
  ): Promise<T> {
    const s = start(text, stepOpts);
    try {
      const result = await fn(s);
      s.done();
      return result;
    } catch (e) {
      s.fail();
      throw e;
    }
  }

  return { log, start, step };
}

const SILENT_STEP: Step = {
  update: () => {},
  done: () => {},
  fail: () => {},
};

export function plainProgress(log: (msg: string) => void): Progress {
  return createProgress({
    animate: false,
    write: (s) => {
      const text = s.replace(/\n$/, "");
      if (text.length > 0) log(text);
    },
  });
}

export function silentProgress(): Progress {
  return createProgress({ silent: true });
}
