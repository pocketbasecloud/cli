import { assert, assertEquals, assertRejects } from "@std/assert";
import { ClientResponseError } from "pocketbase";
import {
  backoffMs,
  fetchWithBusyRetry,
  isBusyError,
  isBusyStatus,
  MAX_DELAY_MS,
  pollDelayMs,
  retryAfterMs,
  withBusyRetry,
} from "../../src/retry.ts";

/** Retries must cost no wall-clock time in a test. */
const nosleep = () => Promise.resolve();

function busyError(
  status = 500,
  message = "database is locked",
  data?: unknown,
): ClientResponseError {
  return new ClientResponseError({
    url: "https://i.example.com/api/collections/posts/records",
    status,
    response: { code: status, message, data },
  });
}

Deno.test("isBusyStatus matches lock contention and nothing else", () => {
  assertEquals(isBusyStatus(500, "database is locked"), true);
  assertEquals(isBusyStatus(500, "Database Is Locked"), true);
  assertEquals(isBusyStatus(500, "SQLITE_BUSY: database is busy"), true);
  assertEquals(isBusyStatus(429), true);
  assertEquals(isBusyStatus(503), true);
  // A 500 that names no lock could have committed; resending risks a duplicate.
  assertEquals(isBusyStatus(500, "Something went wrong."), false);
  assertEquals(isBusyStatus(500), false);
  assertEquals(isBusyStatus(400, "database is locked"), false);
  assertEquals(isBusyStatus(404), false);
});

Deno.test("isBusyError reads the reason out of a field-level entry", () => {
  // PocketBase's top-level message is a generic wrapper; the driver's sentence
  // is one level down.
  const e = busyError(500, "Failed to create record.", {
    "": { code: "db_error", message: "database is locked" },
  });
  assertEquals(isBusyError(e), true);
});

Deno.test("isBusyError ignores anything that is not a busy response", () => {
  assertEquals(isBusyError(busyError(400, "Failed to create record.")), false);
  assertEquals(isBusyError(new Error("database is locked")), false);
  assertEquals(isBusyError("database is locked"), false);
  assertEquals(isBusyError(undefined), false);
});

Deno.test("withBusyRetry resends a busy write until it lands", async () => {
  let attempts = 0;
  const got = await withBusyRetry(() => {
    attempts++;
    if (attempts < 3) return Promise.reject(busyError());
    return Promise.resolve("written");
  }, { sleep: nosleep });
  assertEquals(got, "written");
  assertEquals(attempts, 3);
});

Deno.test("withBusyRetry gives up after maxAttempts and rethrows as-is", async () => {
  let attempts = 0;
  const thrown = await assertRejects(() =>
    withBusyRetry(() => {
      attempts++;
      return Promise.reject(busyError());
    }, { sleep: nosleep, maxAttempts: 4 })
  );
  assertEquals(attempts, 4);
  // Untouched, so the caller's own mapping still produces the user's message.
  assert(thrown instanceof ClientResponseError);
});

Deno.test("withBusyRetry does not resend a write that may have committed", async () => {
  let attempts = 0;
  await assertRejects(() =>
    withBusyRetry(() => {
      attempts++;
      return Promise.reject(busyError(400, "Failed to create record."));
    }, { sleep: nosleep })
  );
  assertEquals(attempts, 1);
});

Deno.test("backoffMs jitters within a doubling ceiling and stays capped", () => {
  // Full jitter: the floor is 0 and the ceiling doubles per attempt.
  assertEquals(backoffMs(1, () => 1), 120);
  assertEquals(backoffMs(2, () => 1), 240);
  assertEquals(backoffMs(3, () => 1), 480);
  assertEquals(backoffMs(1, () => 0), 0);
  assertEquals(backoffMs(50, () => 1), MAX_DELAY_MS);
  for (let attempt = 1; attempt <= 10; attempt++) {
    const d = backoffMs(attempt);
    assert(d >= 0 && d <= MAX_DELAY_MS, `attempt ${attempt} gave ${d}`);
  }
});

Deno.test("retryAfterMs honours both header forms and rejects nonsense", () => {
  assertEquals(retryAfterMs("1"), 1000);
  assertEquals(retryAfterMs("0"), 0);
  // Capped, so a server asking for an hour does not hang the CLI for one.
  assertEquals(retryAfterMs("3600"), MAX_DELAY_MS);
  assertEquals(retryAfterMs(null), undefined);
  assertEquals(retryAfterMs("soon"), undefined);
  const oneSecOut = new Date(Date.now() + 1000).toUTCString();
  const fromDate = retryAfterMs(oneSecOut);
  assert(fromDate !== undefined && fromDate <= 1000);
  // A date already in the past means "now", never a negative wait.
  assertEquals(retryAfterMs(new Date(Date.now() - 60_000).toUTCString()), 0);
});

Deno.test("fetchWithBusyRetry retries a 503 and hands back a readable body", async () => {
  let attempts = 0;
  const res = await fetchWithBusyRetry(() => {
    attempts++;
    return Promise.resolve(
      attempts < 3
        ? new Response("busy", { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  }, { sleep: nosleep });
  assertEquals(attempts, 3);
  assertEquals(res.status, 200);
  // The caller parses this exactly as it would an un-retried response.
  assertEquals(await res.json(), { ok: true });
});

Deno.test("fetchWithBusyRetry retries a 500 only when it names the lock", async () => {
  let locked = 0;
  const lockedRes = await fetchWithBusyRetry(() => {
    locked++;
    return Promise.resolve(
      new Response(JSON.stringify({ message: "database is locked" }), {
        status: 500,
      }),
    );
  }, { sleep: nosleep, maxAttempts: 3 });
  assertEquals(locked, 3);
  assertEquals(lockedRes.status, 500);

  let generic = 0;
  const genericRes = await fetchWithBusyRetry(() => {
    generic++;
    return Promise.resolve(
      new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    );
  }, { sleep: nosleep });
  assertEquals(generic, 1);
  // Body still intact for the caller's error reporting.
  assertEquals(await genericRes.json(), { message: "boom" });
});

Deno.test("fetchWithBusyRetry leaves a plain failure alone", async () => {
  let attempts = 0;
  const res = await fetchWithBusyRetry(() => {
    attempts++;
    return Promise.resolve(new Response("nope", { status: 400 }));
  }, { sleep: nosleep });
  assertEquals(attempts, 1);
  assertEquals(res.status, 400);
  assertEquals(await res.text(), "nope");
});

Deno.test("fetchWithBusyRetry waits as long as Retry-After asks", async () => {
  const waits: number[] = [];
  let attempts = 0;
  await fetchWithBusyRetry(() => {
    attempts++;
    return Promise.resolve(
      attempts === 1
        ? new Response("slow down", {
          status: 429,
          headers: { "retry-after": "1" },
        })
        : new Response("{}", { status: 200 }),
    );
  }, {
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(waits, [1000]);
});

Deno.test("pollDelayMs holds the interval, then stretches to its cap", () => {
  const mid = () => 0.5; // no jitter offset
  const base = 3_000;
  const opts = { baseMs: base, maxMs: 15_000, steadyPolls: 5, random: mid };
  // Early on, a deploy may still finish quickly — keep checking at the
  // caller's pace.
  assertEquals(pollDelayMs(1, opts), base);
  assertEquals(pollDelayMs(5, opts), base);
  // Then back away.
  assert(pollDelayMs(6, opts) > base);
  assert(pollDelayMs(7, opts) > pollDelayMs(6, opts));
  assertEquals(pollDelayMs(99, opts), 15_000);
});

Deno.test("pollDelayMs jitters ±20% so parallel clients drift apart", () => {
  const opts = { baseMs: 1_000, maxMs: 10_000 };
  assertEquals(pollDelayMs(1, { ...opts, random: () => 0 }), 800);
  assertEquals(pollDelayMs(1, { ...opts, random: () => 1 }), 1200);
  for (let attempt = 1; attempt <= 30; attempt++) {
    const d = pollDelayMs(attempt, opts);
    assert(d >= 800 && d <= 12_000, `attempt ${attempt} gave ${d}`);
  }
});
