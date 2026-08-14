import { assertEquals, assertStringIncludes } from "@std/assert";
import { httpError } from "../../src/errors.ts";
import { describeSubStatus } from "../../src/deploy-status.ts";

function res(body: unknown, status = 400): Response {
  return typeof body === "string"
    ? new Response(body, { status })
    : new Response(JSON.stringify(body), { status });
}

Deno.test("httpError repeats the reason PocketBase's routes put in `details`", async () => {
  // The route answers { error: <wrapper>, details: <the useful sentence> }.
  // Reporting the status code alone, which is what most call sites did, throws
  // the second one away.
  const e = await httpError(
    res({
      error: "Failed to set env vars",
      details: "Backend container is not running",
    }),
    "Set",
  );
  assertEquals(e.message, "Set failed (400): Backend container is not running");
  assertEquals(e.exitCode, 1);
});

Deno.test("httpError skips a wrapper that says nothing", async () => {
  // backend-extension answers a 500 with the generic message on top and the
  // real failure underneath.
  const e = await httpError(
    res({ message: "Internal server error", error: "ENOSPC on /var/lib" }, 500),
    "Import",
  );
  assertEquals(e.message, "Import failed (500): ENOSPC on /var/lib");
});

Deno.test("httpError digs a field error out of a re-wrapped PocketBase body", async () => {
  // The shape a hook that exceeds `content`'s max arrives in: the PocketBase
  // response body nested two levels down, with nothing but the wrapper on top.
  const e = await httpError(
    res({
      details: {
        data: {
          data: {
            content: {
              code: "validation_max_text_constraint",
              message: "Must be no more than 100000 character(s).",
              params: { max: 100000 },
            },
          },
          message: "Failed to create record.",
          status: 400,
        },
      },
    }),
    "Hook push",
  );
  assertEquals(
    e.message,
    "Hook push failed (400): content: must be no more than 100,000 characters",
  );
});

Deno.test("httpError does not read the envelope as three rejected fields", async () => {
  // `details.data` is `{ data, message, status }` — stepping into it blindly
  // reports "data: invalid; message: invalid; status: invalid".
  const e = await httpError(
    res({ details: { data: { message: "Nope.", status: 400 } } }),
    "Hook push",
  );
  assertEquals(e.message, "Hook push failed (400): Nope.");
});

Deno.test("httpError falls back to the status code when the body says nothing", async () => {
  const e = await httpError(res("not json", 502), "Hook push");
  assertEquals(e.message, "Hook push failed (502).");
  assertEquals(e.exitCode, 1);
});

Deno.test("httpError names the fix for an expired session", async () => {
  const e = await httpError(res({}, 401), "Log stream");
  assertEquals(
    e.message,
    "Log stream failed (401): not authenticated — run `pb cloud login`",
  );
  // Exit 4 is the CLI's "log in again", as `mapPbError` already reports.
  assertEquals(e.exitCode, 4);
});

Deno.test("httpError keeps the platform's own 403 reason and exit code", async () => {
  const e = await httpError(
    res({ message: "Backend deployments require a Pro plan" }, 403),
    "Deploy",
  );
  assertEquals(
    e.message,
    "Deploy failed (403): Backend deployments require a Pro plan",
  );
  assertEquals(e.exitCode, 3);
});

Deno.test("describeSubStatus explains a failure and stays quiet otherwise", () => {
  assertEquals(
    describeSubStatus("computeFull"),
    "your compute is full — add-ons coming soon",
  );
  // A refused archive is the one upload failure the user can act on, so it
  // must not fall back to the generic "could not be written" line.
  assertStringIncludes(
    describeSubStatus("archiveMissingPbDirs") ?? "",
    "pb_public",
  );
  assertStringIncludes(
    describeSubStatus("archiveMissingPbDirs") ?? "",
    "pb_hooks",
  );
  assertStringIncludes(
    describeSubStatus("hooksNotInstallable") ?? "",
    "subdirectory",
  );
  // Progress sub-statuses are not failures, and an unknown one is not worth a
  // guess — the caller says only what it knows.
  assertEquals(describeSubStatus("sendingToServer"), undefined);
  assertEquals(describeSubStatus(""), undefined);
  assertEquals(describeSubStatus(undefined), undefined);
});
