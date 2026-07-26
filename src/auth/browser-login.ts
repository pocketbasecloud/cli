import { BACKEND_EXT_URL, BACKEND_URL, type CloudAuth } from "../config.ts";
import { CliError } from "../errors.ts";

export function buildLoginUrl(
  portalUrl: string,
  port: number,
  state: string,
): string {
  const u = new URL(portalUrl);
  u.searchParams.set("cli_callback", `http://localhost:${port}/callback`);
  u.searchParams.set("state", state);
  return u.toString();
}

export function parseCallback(
  url: URL,
  expectedState: string,
): { userToken: string; userId: string } {
  if (url.searchParams.get("state") !== expectedState) {
    throw new CliError("Login failed: state mismatch (possible CSRF).", 4);
  }
  const userToken = url.searchParams.get("token");
  if (!userToken) throw new CliError("Login failed: no token in callback.", 4);
  return { userToken, userId: url.searchParams.get("userId") ?? "" };
}

function openBrowser(url: string): void {
  const cmd = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "explorer"
    : "xdg-open";
  new Deno.Command(cmd, { args: [url] }).spawn();
}

export function browserLogin(opts: {
  portalUrl: string;
  open?: (url: string) => void;
  port?: number;
}): Promise<CloudAuth> {
  const state = crypto.randomUUID();
  const open = opts.open ?? openBrowser;
  return new Promise<CloudAuth>((resolve, reject) => {
    const server = Deno.serve({
      port: opts.port ?? 0,
      onListen: ({ port }) => {
        open(buildLoginUrl(opts.portalUrl, port, state));
      },
    }, (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 });
      }
      try {
        const { userToken, userId } = parseCallback(url, state);
        resolve({
          backendUrl: BACKEND_URL,
          extUrl: BACKEND_EXT_URL,
          userToken,
          userId,
        });
        queueMicrotask(() => server.shutdown());
        return new Response("Login complete. You can close this tab.", {
          status: 200,
        });
      } catch (e) {
        reject(e);
        queueMicrotask(() => server.shutdown());
        return new Response("Login failed.", { status: 400 });
      }
    });
  });
}
