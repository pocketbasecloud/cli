import { assertEquals, assertRejects } from "@std/assert";
import { deviceLogin } from "../../src/auth/device-login.ts";
import { CliError } from "../../src/errors.ts";

const STARTED = {
  deviceCode: "d".repeat(64),
  userCode: "BCDF-GHJK",
  verificationUri: "https://portal.test/device?code=BCDF-GHJK",
  expiresIn: 600,
  interval: 5,
};

function platform(polls: unknown[]) {
  const requests: { path: string; body: unknown }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: JSON.parse(String(init.body)) });
    const data = path === "/api/device/code" ? STARTED : polls.shift();
    return Promise.resolve(Response.json({ success: true, data }));
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

Deno.test("deviceLogin shows the code, opens the page and waits for approval", async () => {
  const { fetchFn, requests } = platform([{ status: "pending" }, {
    status: "approved",
    token: "pbc_d_x",
  }]);
  const opened: string[] = [];
  const told: string[] = [];
  const waits: number[] = [];
  const token = await deviceLogin({
    extUrl: "https://ext.test",
    name: "MacBook",
    fetchFn,
    open: (url) => opened.push(url),
    notify: (line) => told.push(line),
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(token, "pbc_d_x");
  assertEquals(opened, ["https://portal.test/device"]);
  assertEquals(told.some((line) => line.includes("BCDF-GHJK")), true);
  assertEquals(requests[0], {
    path: "/api/device/code",
    body: { name: "MacBook" },
  });
  assertEquals(requests[1], {
    path: "/api/device/token",
    body: { deviceCode: STARTED.deviceCode },
  });
  assertEquals(waits, [5000, 5000]);
});

Deno.test("deviceLogin stops on a denied or expired login", async () => {
  for (const status of ["denied", "expired"]) {
    const { fetchFn } = platform([{ status }]);
    await assertRejects(
      () =>
        deviceLogin({
          extUrl: "https://ext.test",
          name: "x",
          fetchFn,
          open: () => {},
          notify: () => {},
          sleep: () => Promise.resolve(),
        }),
      CliError,
    );
  }
});

Deno.test("deviceLogin still works when no browser can be opened", async () => {
  const { fetchFn } = platform([{ status: "approved", token: "pbc_d_y" }]);
  const token = await deviceLogin({
    extUrl: "https://ext.test",
    name: "server",
    fetchFn,
    open: () => {
      throw new Error("no browser");
    },
    notify: () => {},
    sleep: () => Promise.resolve(),
  });
  assertEquals(token, "pbc_d_y");
});

Deno.test("deviceLogin opens and prints the page without the code, so the person types it", async () => {
  const { fetchFn } = platform([{ status: "approved", token: "pbc_d_x" }]);
  const opened: string[] = [];
  const told: string[] = [];
  await deviceLogin({
    extUrl: "https://ext.test",
    name: "MacBook",
    fetchFn,
    open: (url) => opened.push(url),
    notify: (line) => told.push(line),
    sleep: () => Promise.resolve(),
  });
  assertEquals(opened, ["https://portal.test/device"]);
  assertEquals(told.some((line) => line.includes("code=")), false);
  assertEquals(told.some((line) => line.includes("https://portal.test/device")), true);
});

function flakyPlatform(answers: Response[]) {
  let polls = 0;
  const fetchFn = ((url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/device/code") {
      return Promise.resolve(Response.json({ success: true, data: STARTED }));
    }
    polls++;
    const answer = answers.shift();
    if (!answer) return Promise.reject(new TypeError("network down"));
    return Promise.resolve(answer);
  }) as unknown as typeof fetch;
  return { fetchFn, polls: () => polls };
}

Deno.test("deviceLogin keeps polling through 5xx and 429, slowing down on 429", async () => {
  const { fetchFn } = flakyPlatform([
    Response.json({ message: "bad gateway" }, { status: 502 }),
    Response.json({ message: "slow down" }, { status: 429 }),
    Response.json({ success: true, data: { status: "pending" } }),
    Response.json({ success: true, data: { status: "approved", token: "pbc_d_z" } }),
  ]);
  const waits: number[] = [];
  const token = await deviceLogin({
    extUrl: "https://ext.test",
    name: "x",
    fetchFn,
    open: () => {},
    notify: () => {},
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(token, "pbc_d_z");
  assertEquals(waits, [5000, 5000, 10000, 10000]);
});

Deno.test("deviceLogin gives up on transient errors only at the deadline", async () => {
  const always503 = Array.from({ length: 200 }, () => Response.json({}, { status: 503 }));
  const { fetchFn, polls } = flakyPlatform(always503);
  await assertRejects(
    () =>
      deviceLogin({
        extUrl: "https://ext.test",
        name: "x",
        fetchFn,
        open: () => {},
        notify: () => {},
        sleep: () => Promise.resolve(),
      }),
    CliError,
    "expired",
  );
  assertEquals(polls(), STARTED.expiresIn / STARTED.interval);
});

Deno.test("deviceLogin keeps polling when the network drops", async () => {
  const { fetchFn, polls } = flakyPlatform([]);
  await assertRejects(
    () =>
      deviceLogin({
        extUrl: "https://ext.test",
        name: "x",
        fetchFn,
        open: () => {},
        notify: () => {},
        sleep: () => Promise.resolve(),
      }),
    CliError,
    "expired",
  );
  assertEquals(polls(), STARTED.expiresIn / STARTED.interval);
});

Deno.test("deviceLogin stops at once on a 4xx refusal", async () => {
  const { fetchFn, polls } = flakyPlatform([
    Response.json({ message: "bad request" }, { status: 400 }),
  ]);
  await assertRejects(
    () =>
      deviceLogin({
        extUrl: "https://ext.test",
        name: "x",
        fetchFn,
        open: () => {},
        notify: () => {},
        sleep: () => Promise.resolve(),
      }),
  );
  assertEquals(polls(), 1);
});
