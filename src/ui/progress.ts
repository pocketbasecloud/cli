/**
 * Progress reporting for the waits a deploy is made of.
 *
 * A deploy spends most of its wall clock in three places that print nothing
 * while they run: the build, the upload of an archive that can be tens of
 * megabytes, and the poll that waits for the platform to finish provisioning.
 * Silence there is indistinguishable from a hang, and the first thing a user
 * does about a hang is Ctrl-C — in the middle of an upload.
 *
 * So every wait is a *step*: it says what it is doing, animates while it runs,
 * and closes with a mark and how long it took. The animation is a courtesy of
 * the terminal, never a requirement: piped output and `--json` degrade to plain
 * lines and to silence respectively, because a spinner's escape codes belong to
 * nobody but a TTY.
 */

/** A step in flight. Ends exactly once, by `done` or `fail`. */
export type Step = {
  /** Replace the text shown while the step runs. */
  update(text: string): void;
  /** Close the step successfully, optionally rewording it. */
  done(text?: string): void;
  /** Close the step as failed, optionally rewording it. */
  fail(text?: string): void;
};

export type Progress = {
  /** A line that is not a step. Never collides with a running animation. */
  log(text: string): void;
  start(text: string, opts?: StepOptions): Step;
  /**
   * Run `fn` as a step. Closes with `done` on return and `fail` on throw,
   * unless `fn` closed it itself — so a step can end with its own wording
   * ("api is running") rather than the one it started with.
   */
  step<T>(
    text: string,
    fn: (step: Step) => Promise<T>,
    opts?: StepOptions,
  ): Promise<T>;
};

export type StepOptions = {
  /**
   * False for a step whose own output shares this stream — a build subprocess,
   * say. Frames drawn against someone else's writes produce garbage, so such a
   * step announces itself, stays quiet, and reports when it is done.
   */
  animate?: boolean;
};

export type Ticker = { stop: () => void };

export type ProgressOptions = {
  /** Where everything goes. Default: stdout, where human output already goes. */
  write?: (s: string) => void;
  /** Draw frames. Default: on when stdout is a terminal and not silent. */
  animate?: boolean;
  /** Write nothing at all — `--json`, where stdout carries one object. */
  silent?: boolean;
  /** Injected in tests. */
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

/** Whole seconds, minutes past a minute. Tenths would only flicker. */
export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/**
 * One rendered line. Elapsed time appears only once there is some — a step that
 * finishes instantly should not be labelled "0s", which reads as a stall.
 */
export function renderLine(
  mark: string,
  text: string,
  elapsedMs: number,
  columns = 80,
): string {
  const suffix = elapsedMs >= 1000 ? ` ${formatElapsed(elapsedMs)}` : "";
  const line = `${mark} ${text}${suffix}`;
  // One column spare: a line filling the last cell wraps on some terminals,
  // and a wrapped line cannot be erased by the carriage return that follows.
  const limit = Math.max(columns - 1, 20);
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function terminalColumns(): number {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return 80; // Not a terminal, or one that will not say. 80 is safe.
  }
}

function stdoutIsTerminal(): boolean {
  try {
    return Deno.stdout.isTerminal();
  } catch {
    return false;
  }
}

/**
 * Braille frames and check marks are a modern-terminal assumption. Windows
 * consoles other than Windows Terminal render them as boxes, so they get ASCII.
 */
function supportsUnicode(): boolean {
  if (Deno.build.os !== "windows") return true;
  return Boolean(Deno.env.get("WT_SESSION"));
}

const defaultSchedule = (tick: () => void, intervalMs: number): Ticker => {
  const id = setInterval(tick, intervalMs);
  // A spinner must never be the reason a process stays alive.
  Deno.unrefTimer(id);
  return { stop: () => clearInterval(id) };
};

/**
 * The step currently animating, if any. Module-level because the thing that
 * has to interrupt it — a prompt — is nowhere near the code that started it.
 */
let live: { suspend: () => void; resume: () => void } | null = null;

/**
 * Run `fn` with any running animation suspended, so a prompt owns the line it
 * writes on. Safe when nothing is running, which is the usual case.
 */
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
      Deno.stdout.writeSync(ENCODER.encode(s));
    });
  const animate = silent ? false : (opts.animate ?? stdoutIsTerminal());
  const unicode = opts.unicode ?? supportsUnicode();
  const now = opts.now ?? (() => Date.now());
  const columns = opts.columns ?? terminalColumns;
  const schedule = opts.schedule ?? defaultSchedule;
  const intervalMs = opts.intervalMs ?? 80;
  const frames = unicode ? FRAMES_UNICODE : FRAMES_ASCII;
  const marks = unicode ? MARKS_UNICODE : MARKS_ASCII;

  /** State of the animated step that owns the current line, if any. */
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
    // The animation owns the last line; give it back before writing over it,
    // then redraw underneath so the step is still visible while it runs.
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
      // No frames to watch, so the intent has to be stated up front: this is
      // the line a piped log shows while the step is running.
      line(renderLine(marks.pending, `${text}…`, 0, columns()));
    }

    const state = { text, startedAt, frame: 0, ticker: null as Ticker | null };
    if (animated) {
      // Two animated steps at once would draw over each other. The older one
      // stops animating; it still closes and prints its own line.
      suspend();
      current = state;
      live = { suspend, resume };
      resume();
    }

    const close = (mark: string, closingText?: string) => {
      if (closed) return;
      closed = true;
      if (closingText !== undefined) state.text = closingText;
      // Only the step that owns the line may clear it.
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
          // Without frames there is nothing to redraw, so a change of wording
          // has to be its own line — that is how a piped log keeps reporting
          // the provisioning status it used to print one line at a time.
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

/**
 * A Progress over a plain line-logger: steps announce and report, nothing
 * animates. This is what lets a helper take a `Progress` unconditionally while
 * its callers still pass an ordinary `log` function.
 */
export function plainProgress(log: (msg: string) => void): Progress {
  return createProgress({
    animate: false,
    write: (s) => {
      const text = s.replace(/\n$/, "");
      if (text.length > 0) log(text);
    },
  });
}

/** A Progress that writes nothing — `--json`, and tests that assert elsewhere. */
export function silentProgress(): Progress {
  return createProgress({ silent: true });
}
