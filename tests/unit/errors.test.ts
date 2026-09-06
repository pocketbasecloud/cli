import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  CliError,
  codeFromStatus,
  type ErrorCode,
  EXIT_CODES,
  httpError,
} from "../../src/errors.ts";
import { describeSubStatus } from "../../src/deploy-status.ts";

function res(body: unknown, status = 400): Response {
  return typeof body === "string"
    ? new Response(body, { status })
    : new Response(JSON.stringify(body), { status });
}

Deno.test("httpError repeats the reason PocketBase's routes put in `details`", async () => {
  const e = await httpError(
    res({
      error: "Failed to set env vars",
      details: "Backend container is not running",
    }),
    "Set",
  );
  assertEquals(e.message, "Set failed (400): Backend container is not running");
  assertEquals(e.exitCode, EXIT_CODES.PLATFORM);
});

Deno.test("httpError skips a wrapper that says nothing", async () => {
  const e = await httpError(
    res({ message: "Internal server error", error: "ENOSPC on /var/lib" }, 500),
    "Import",
  );
  assertEquals(e.message, "Import failed (500): ENOSPC on /var/lib");
});

Deno.test("httpError digs a field error out of a re-wrapped PocketBase body", async () => {
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
  const e = await httpError(
    res({ details: { data: { message: "Nope.", status: 400 } } }),
    "Hook push",
  );
  assertEquals(e.message, "Hook push failed (400): Nope.");
});

Deno.test("httpError falls back to the status code when the body says nothing", async () => {
  const e = await httpError(res("not json", 502), "Hook push");
  assertEquals(e.message, "Hook push failed (502).");
  assertEquals(e.exitCode, EXIT_CODES.PLATFORM);
});

Deno.test("httpError names the fix for an expired session", async () => {
  const e = await httpError(res({}, 401), "Log stream");
  assertEquals(
    e.message,
    "Log stream failed (401): not authenticated — run `pbc login`",
  );
  assertEquals(e.exitCode, EXIT_CODES.AUTH);
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
  assertEquals(e.exitCode, EXIT_CODES.FORBIDDEN);
});

Deno.test("describeSubStatus explains a failure and stays quiet otherwise", () => {
  assertEquals(
    describeSubStatus("computeFull"),
    "your compute is full — add-ons coming soon",
  );
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
  assertEquals(describeSubStatus("sendingToServer"), undefined);
  assertEquals(describeSubStatus(""), undefined);
  assertEquals(describeSubStatus(undefined), undefined);
});

const PAUSED =
  "This instance is paused because it is over the Free plan storage limit. " +
  "Upgrade to resume it, or free up space and it restarts automatically.";

Deno.test("httpError surfaces a paused instance on a hook push", async () => {
  const e = await httpError(
    res({ error: "Failed to write hooks", details: PAUSED }, 409),
    "Hook push",
  );
  assertStringIncludes(e.message, "paused");
  assertStringIncludes(e.message, "Upgrade to resume it");
});

Deno.test("httpError surfaces a paused instance on an env write", async () => {
  const e = await httpError(
    res({ error: "Failed to set env vars", details: PAUSED }, 409),
    "Set",
  );
  assertStringIncludes(e.message, "paused");
});

Deno.test("httpError surfaces a paused instance from the extension directly", async () => {
  const e = await httpError(
    res(
      { success: false, message: "Failed to set env vars", error: PAUSED },
      409,
    ),
    "Env push",
  );
  assertStringIncludes(e.message, "paused");
});

const ALL_CODES: ErrorCode[] = [
  "USAGE",
  "UNKNOWN_FLAG",
  "MISSING_ARG",
  "NO_TARGET",
  "INVALID_VALUE",
  "NOT_FOUND",
  "NOT_AUTHENTICATED",
  "FORBIDDEN",
  "UPGRADE_REQUIRED",
  "PLAN_LIMIT",
  "CONFLICT",
  "PLATFORM_ERROR",
  "NETWORK_ERROR",
  "INTERNAL",
  "TIMEOUT",
];

Deno.test("every ErrorCode maps to a documented exit code", () => {
  const expected: Record<ErrorCode, number> = {
    USAGE: EXIT_CODES.USAGE,
    UNKNOWN_FLAG: EXIT_CODES.USAGE,
    MISSING_ARG: EXIT_CODES.USAGE,
    NO_TARGET: EXIT_CODES.USAGE,
    INVALID_VALUE: EXIT_CODES.USAGE,
    NOT_FOUND: EXIT_CODES.NOT_FOUND,
    NOT_AUTHENTICATED: EXIT_CODES.AUTH,
    FORBIDDEN: EXIT_CODES.FORBIDDEN,
    UPGRADE_REQUIRED: EXIT_CODES.USAGE,
    PLAN_LIMIT: EXIT_CODES.FORBIDDEN,
    CONFLICT: EXIT_CODES.CONFLICT,
    PLATFORM_ERROR: EXIT_CODES.PLATFORM,
    NETWORK_ERROR: EXIT_CODES.PLATFORM,
    INTERNAL: EXIT_CODES.PLATFORM,
    TIMEOUT: EXIT_CODES.TIMEOUT,
  };
  for (const code of ALL_CODES) {
    assertEquals(
      new CliError("x", { code }).exitCode,
      expected[code],
      `${code} should exit ${expected[code]}`,
    );
  }
});

Deno.test("no ErrorCode is left without a default hint", () => {
  for (const code of ALL_CODES) {
    const e = new CliError("x", { code });
    if (e.hint.length === 0) throw new Error(`${code} has no default hint`);
  }
});

Deno.test("a CliError with no code defaults to PLATFORM_ERROR, exit 7", () => {
  const e = new CliError("x");
  assertEquals(e.code, "PLATFORM_ERROR");
  assertEquals(e.exitCode, EXIT_CODES.PLATFORM);
});

Deno.test("an explicit hint overrides the code's default", () => {
  const e = new CliError("x", { code: "NOT_FOUND", hint: "pbc cloud pb ls" });
  assertEquals(e.hint, "pbc cloud pb ls");
});

Deno.test("codeFromStatus maps the resolvable HTTP statuses", () => {
  assertEquals(codeFromStatus(401), "NOT_AUTHENTICATED");
  assertEquals(codeFromStatus(403), "FORBIDDEN");
  assertEquals(codeFromStatus(404), "NOT_FOUND");
  assertEquals(codeFromStatus(409), "CONFLICT");
  assertEquals(codeFromStatus(413), "INVALID_VALUE");
  assertEquals(codeFromStatus(426), "UPGRADE_REQUIRED");
  assertEquals(codeFromStatus(500), "PLATFORM_ERROR");
  assertEquals(codeFromStatus(502), "PLATFORM_ERROR");
  assertEquals(codeFromStatus(400), undefined);
});

Deno.test("httpError classifies 404 and 409 through the exit-code table", async () => {
  const notFound = await httpError(
    res({ message: "No such record." }, 404),
    "Get",
  );
  assertEquals(notFound.code, "NOT_FOUND");
  assertEquals(notFound.exitCode, EXIT_CODES.NOT_FOUND);

  const conflict = await httpError(
    res({ message: "Already deleted." }, 409),
    "Delete",
  );
  assertEquals(conflict.code, "CONFLICT");
  assertEquals(conflict.exitCode, EXIT_CODES.CONFLICT);
});

Deno.test("TIMEOUT and NETWORK_ERROR default to retryable, USAGE does not", () => {
  assertEquals(new CliError("x", { code: "TIMEOUT" }).retryable, true);
  assertEquals(new CliError("x", { code: "NETWORK_ERROR" }).retryable, true);
  assertEquals(new CliError("x", { code: "USAGE" }).retryable, false);
});

Deno.test("httpError turns a 426 into an upgrade order with the floor", async () => {
  const e = await httpError(
    res({
      error: "This operation needs pbc 9.9.9 or newer.",
      minCliVersion: "9.9.9",
      clientVersion: "0.8.2",
    }, 426),
    "Deploy context",
    "0.8.2",
  );
  assertEquals(e.code, "UPGRADE_REQUIRED");
  assertStringIncludes(e.message, "pbc 0.8.2 is too old (minimum: 9.9.9)");
  assertStringIncludes(e.message, "`pbc self upgrade`");
  assertEquals(e.exitCode, EXIT_CODES.USAGE);
  assertEquals(e.retryable, false);
});

Deno.test("httpError still orders an upgrade when the 426 body is bare", async () => {
  const e = await httpError(res("not json", 426), "Deploy");
  assertEquals(e.code, "UPGRADE_REQUIRED");
  assertStringIncludes(e.message, "is too old for this operation");
  assertStringIncludes(e.message, "`pbc self upgrade`");
});

Deno.test("httpError does not repeat the upgrade order from a 426 body", async () => {
  const e = await httpError(
    res({
      error: "This operation needs pbc 9.9.9 or newer. Run `pbc self upgrade`.",
      minCliVersion: "9.9.9",
    }, 426),
    "Deploy context",
    "0.8.2",
  );
  assertEquals(e.message.split("`pbc self upgrade`").length - 1, 1);
});
