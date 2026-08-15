/**
 * Surviving a busy PocketBase.
 *
 * PocketBase stores everything in SQLite, and SQLite serialises writers: while
 * one write transaction holds the lock, a second gets `SQLITE_BUSY` rather than
 * a queue slot. On a small instance that is entirely normal — a backup running,
 * a hook fanning out records, two `pb` invocations in the same CI job — and the
 * request that loses the race comes back as a 500 whose message names the lock.
 *
 * Failing the command there is the wrong answer: nothing was committed, so the
 * write is safe to send again, and a wait measured in tens of milliseconds is
 * usually all it takes. Everything here exists so a caller can retry *only* the
 * failures that are known to have changed nothing, and back off in a way that
 * does not turn contention into a stampede.
 */

import { ClientResponseError } from "pocketbase";

/** How many times a busy write is sent again before the error is surfaced. */
export const MAX_ATTEMPTS = 5;

/** First wait, doubled per attempt. Short: most lock waits clear in one. */
export const BASE_DELAY_MS = 120;

/** Ceiling per wait, so a long outage does not produce a multi-minute hang. */
export const MAX_DELAY_MS = 2_000;

/**
 * Lock-contention wording, lowercased. SQLite and the drivers above it phrase
 * the same condition several ways, and PocketBase passes the text through
 * rather than mapping it to a code, so matching on the sentence is the only
 * signal available.
 */
const BUSY_PATTERNS = [
  "database is locked",
  "database table is locked",
  "database is busy",
  "sqlite_busy",
  "sqlite_locked",
  "busy_timeout",
  "database schema is locked",
];

/**
 * Statuses that mean "not processed, ask again" on their own terms — a rate
 * limiter or a proxy in front of an instance that is still starting. Neither
 * ran the write, so neither can have committed it.
 */
const RETRYABLE_STATUSES = new Set([429, 503]);

/**
 * Whether `status` + `message` describe a request that was refused before it
 * changed anything.
 *
 * A 500 counts only when its text names the lock. Retrying every 500 would
 * risk sending a create a second time after the first one actually landed,
 * which is how a retry turns into a duplicate record.
 */
export function isBusyStatus(status: number, message?: string): boolean {
  if (RETRYABLE_STATUSES.has(status)) return true;
  if (status !== 500) return false;
  const text = (message ?? "").toLowerCase();
  return BUSY_PATTERNS.some((p) => text.includes(p));
}

/** Every string PocketBase might have hidden the driver's message under. */
function messageOf(e: ClientResponseError): string {
  const response = e.response as
    | { message?: unknown; data?: unknown }
    | undefined;
  const parts = [e.message, response?.message];
  // Field-level entries carry the reason when the top-level message is one of
  // PocketBase's generic wrappers.
  const data = response?.data;
  if (data && typeof data === "object") {
    for (const v of Object.values(data as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const m = (v as { message?: unknown }).message;
        if (typeof m === "string") parts.push(m);
      }
    }
  }
  return parts.filter((p): p is string => typeof p === "string").join(" ");
}

/** Whether a thrown SDK error is a lock the caller may wait out. */
export function isBusyError(e: unknown): boolean {
  if (!(e instanceof ClientResponseError)) return false;
  return isBusyStatus(e.status, messageOf(e));
}

/**
 * The wait before attempt `attempt` (1-based), as full jitter: a random point
 * in [0, exponential]. Two CLIs that collide on the same lock must not wake at
 * the same moment and collide again, which is exactly what a fixed backoff
 * guarantees.
 */
export function backoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.round(random() * ceiling);
}

/**
 * `Retry-After`, in milliseconds, when the server named a delay it wants
 * honoured. Both forms are allowed: seconds, or an HTTP date.
 */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_DELAY_MS);
  }
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), MAX_DELAY_MS);
}

/**
 * The wait before the next poll of a long-running operation.
 *
 * A fixed interval is the wrong shape for a wait whose length is unknown. A
 * deploy that finishes in ten seconds wants to be noticed immediately; one
 * that takes five minutes does not need a hundred queries to confirm it is
 * still building, and each of those queries is a connection an instance under
 * write pressure has to serve. So the first `steadyPolls` keep the caller's
 * interval, and the rest grow geometrically towards `maxMs`.
 *
 * The jitter is what stops a CI matrix of ten jobs, all started together, from
 * polling the same instance in lockstep for the whole run.
 */
export function pollDelayMs(
  attempt: number,
  opts: {
    baseMs: number;
    maxMs?: number;
    steadyPolls?: number;
    factor?: number;
    random?: () => number;
  },
): number {
  const steady = opts.steadyPolls ?? 5;
  const factor = opts.factor ?? 1.5;
  const maxMs = opts.maxMs ?? Math.max(opts.baseMs, 15_000);
  const grown = attempt <= steady
    ? opts.baseMs
    : opts.baseMs * factor ** (attempt - steady);
  const capped = Math.min(grown, maxMs);
  // ±20%, so identical clients drift apart instead of synchronising.
  const random = opts.random ?? Math.random;
  return Math.round(capped * (0.8 + random() * 0.4));
}

export type RetryOpts = {
  maxAttempts?: number;
  /** Swapped out in tests so a retry costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called before each wait, for progress output. */
  onRetry?: (attempt: number, delayMs: number) => void;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((res) => setTimeout(res, ms));

/**
 * Runs `fn`, resending it while it fails on a busy database.
 *
 * Only wraps calls whose failure is known to have written nothing — see
 * `isBusyStatus`. The last error is rethrown untouched once the attempts run
 * out, so the caller's own error mapping still produces the message a user
 * sees.
 */
export async function withBusyRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1;; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= maxAttempts || !isBusyError(e)) throw e;
      const delay = backoffMs(attempt, opts.random);
      opts.onRetry?.(attempt, delay);
      await sleep(delay);
    }
  }
}

/**
 * The same policy for the routes called through `fetch` rather than the SDK,
 * which report a busy instance as a `Response` instead of throwing.
 *
 * The body of a candidate response is read from a clone, so the `Response`
 * handed back is still unread and the caller can parse it exactly as before.
 */
export async function fetchWithBusyRetry(
  send: () => Promise<Response>,
  opts: RetryOpts = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1;; attempt++) {
    const res = await send();
    if (res.ok || attempt >= maxAttempts) return res;

    // Only a candidate status is worth buffering a body for.
    if (!isBusyStatus(res.status)) {
      const text = res.status === 500
        ? await res.clone().text().catch(() => "")
        : "";
      if (!isBusyStatus(res.status, text)) return res;
    }

    const delay = retryAfterMs(res.headers.get("retry-after")) ??
      backoffMs(attempt, opts.random);
    opts.onRetry?.(attempt, delay);
    // The response is being discarded, so release its body rather than leaving
    // the connection pinned open for the length of the wait.
    await res.body?.cancel().catch(() => {});
    await sleep(delay);
  }
}
