import { CliError, httpError } from "../errors.ts";

const SECOND_MS = 1000;

type Started = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

type Poll =
  | { status: "pending" | "denied" | "expired" | "invalid" }
  | { status: "approved"; token: string };

export type DeviceLoginDeps = {
  extUrl: string;
  name: string;
  fetchFn?: typeof fetch;
  open: (url: string) => void;
  notify: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

async function post<T>(
  deps: DeviceLoginDeps,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await (deps.fetchFn ?? fetch)(`${deps.extUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res, "Login");
  return ((await res.json()) as { data: T }).data;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const SLOW_DOWN_SECONDS = 5;

type PollAttempt = Poll | { status: "retry" | "slow_down" };

async function pollOnce(
  deps: DeviceLoginDeps,
  deviceCode: string,
): Promise<PollAttempt> {
  let res: Response;
  try {
    res = await (deps.fetchFn ?? fetch)(`${deps.extUrl}/api/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
  } catch {
    return { status: "retry" };
  }
  if (res.status === HTTP_TOO_MANY_REQUESTS) {
    await res.body?.cancel();
    return { status: "slow_down" };
  }
  if (res.status >= HTTP_SERVER_ERROR) {
    await res.body?.cancel();
    return { status: "retry" };
  }
  if (!res.ok) throw await httpError(res, "Login");
  return ((await res.json()) as { data: Poll }).data;
}

function pageWithoutCode(verificationUri: string): string {
  const page = new URL(verificationUri);
  page.search = "";
  return page.toString();
}

export async function deviceLogin(deps: DeviceLoginDeps): Promise<string> {
  const started = await post<Started>(deps, "/api/device/code", {
    name: deps.name,
  });
  const page = pageWithoutCode(started.verificationUri);
  deps.notify(`Open ${page} and type the code ${started.userCode}.`);
  try {
    deps.open(page);
  } catch {
    deps.notify("Could not open a browser here; open the link on any device.");
  }

  const sleep = deps.sleep ?? wait;
  const deadlineMs = started.expiresIn * SECOND_MS;
  let intervalMs = started.interval * SECOND_MS;
  let waitedMs = 0;
  while (waitedMs < deadlineMs) {
    await sleep(intervalMs);
    waitedMs += intervalMs;
    const poll = await pollOnce(deps, started.deviceCode);
    if (poll.status === "approved") return poll.token;
    if (poll.status === "slow_down") {
      intervalMs += SLOW_DOWN_SECONDS * SECOND_MS;
      continue;
    }
    if (poll.status === "pending" || poll.status === "retry") continue;
    throw new CliError(
      poll.status === "denied"
        ? "Login was denied in the browser."
        : "The login code expired. Run `pbc login` again.",
      { code: "NOT_AUTHENTICATED" },
    );
  }
  throw new CliError("The login code expired. Run `pbc login` again.", {
    code: "NOT_AUTHENTICATED",
  });
}

export function openBrowser(url: string): void {
  const cmd = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "explorer"
    : "xdg-open";
  new Deno.Command(cmd, { args: [url], stdout: "null", stderr: "null" })
    .spawn();
}
