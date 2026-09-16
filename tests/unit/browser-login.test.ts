import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  browserLogin,
  buildLoginUrl,
  parseCallback,
} from "../../src/auth/browser-login.ts";
import { CliError } from "../../src/errors.ts";

Deno.test("buildLoginUrl encodes callback and state", () => {
  const u = new URL(buildLoginUrl("https://portal.app", 51888, "abc"));
  assertEquals(
    u.searchParams.get("cli_callback"),
    "http://localhost:51888/callback",
  );
  assertEquals(u.searchParams.get("state"), "abc");
});

Deno.test("parseCallback extracts token when state matches", () => {
  const url = new URL("http://localhost/callback?state=abc&token=TT&userId=u9");
  assertEquals(parseCallback(url, "abc"), { userToken: "TT", userId: "u9" });
});

Deno.test("parseCallback rejects state mismatch", () => {
  const url = new URL("http://localhost/callback?state=bad&token=TT");
  assertThrows(() => parseCallback(url, "abc"));
});

Deno.test("parseCallback rejects missing token", () => {
  const url = new URL("http://localhost/callback?state=abc");
  assertThrows(() => parseCallback(url, "abc"));
});

Deno.test("browserLogin surfaces a --token hint when no browser can be opened", async () => {
  const err = await assertRejects(
    () =>
      browserLogin({
        portalUrl: "https://portal.app",
        port: 0,
        open: () => {
          throw new Deno.errors.NotFound("Failed to spawn 'xdg-open'");
        },
      }),
    CliError,
  );
  assertEquals(err.code, "NOT_AUTHENTICATED");
  assertEquals(err.message.includes("--token"), true);
});
