import { assertEquals } from "@std/assert";
import { portalHandoff } from "../../src/portal-handoff.ts";

const sessionOnly = () =>
  Response.json(
    {
      success: false,
      error: "session",
      code: "tokenScope",
      message: "Billing … only in the portal.",
    },
    { status: 403 },
  );

Deno.test("a session-only refusal opens the portal page and says so", async () => {
  const opened: string[] = [];
  const error = await portalHandoff(
    sessionOnly(),
    "https://portal.test/account#self-driving",
    (url) => opened.push(url),
  );
  assertEquals(opened, ["https://portal.test/account#self-driving"]);
  assertEquals(error?.code, "FORBIDDEN");
  assertEquals(
    error?.message.includes("https://portal.test/account#self-driving"),
    true,
  );
});

Deno.test("other refusals are left to the usual error", async () => {
  const opened: string[] = [];
  const other = Response.json({ success: false, error: "permission" }, {
    status: 403,
  });
  assertEquals(
    await portalHandoff(
      other,
      "https://portal.test",
      (url) => opened.push(url),
    ),
    null,
  );
  assertEquals(opened, []);
});

Deno.test("a computer without a browser still gets the link", async () => {
  const error = await portalHandoff(
    sessionOnly(),
    "https://portal.test/x",
    () => {
      throw new Error("no browser");
    },
  );
  assertEquals(error?.message.includes("https://portal.test/x"), true);
});
