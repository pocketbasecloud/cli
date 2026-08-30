import { assertEquals } from "@std/assert";
import { emit, emitError, note, SCHEMA_VERSION } from "../../src/envelope.ts";
import { CliError } from "../../src/errors.ts";

function capture(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s) => lines.push(s) };
}

Deno.test("emit writes exactly one enveloped object under --json", () => {
  const { lines, write } = capture();
  emit(true, { name: "web" }, "web", write);
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    data: { name: "web" },
  });
});

Deno.test("emit writes the human text when --json is off", () => {
  const { lines, write } = capture();
  emit(false, { name: "web" }, "web is running", write);
  assertEquals(lines, ["web is running"]);
});

Deno.test("emit lazily evaluates a function human branch only when not --json", () => {
  const { lines, write } = capture();
  let calls = 0;
  const human = () => {
    calls++;
    return "table text";
  };
  emit(true, { a: 1 }, human, write);
  assertEquals(calls, 0);
  emit(false, { a: 1 }, human, write);
  assertEquals(calls, 1);
  assertEquals(lines[1], "table text");
});

Deno.test("emitError writes the enveloped failure to the given writer under --json", () => {
  const { lines, write } = capture();
  const err = new CliError("No target.", { code: "NO_TARGET" });
  emitError(true, err, write);
  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assertEquals(parsed.ok, false);
  assertEquals(parsed.schemaVersion, SCHEMA_VERSION);
  assertEquals(parsed.error.code, "NO_TARGET");
  assertEquals(parsed.error.message, "No target.");
  assertEquals(parsed.error.hint.length > 0, true);
  assertEquals(parsed.error.retryable, false);
  assertEquals("docs" in parsed.error, false);
});

Deno.test("emitError includes docs only when the error carries one", () => {
  const { lines, write } = capture();
  const err = new CliError("x", {
    code: "PLATFORM_ERROR",
    docs: "https://example.com/docs",
  });
  emitError(true, err, write);
  const parsed = JSON.parse(lines[0]);
  assertEquals(parsed.error.docs, "https://example.com/docs");
});

Deno.test("emitError writes nothing when --json is off", () => {
  const { lines, write } = capture();
  emitError(false, new CliError("x"), write);
  assertEquals(lines.length, 0);
});

Deno.test("emitError reflects a retryable error", () => {
  const { lines, write } = capture();
  emitError(true, new CliError("timed out", { code: "TIMEOUT" }), write);
  const parsed = JSON.parse(lines[0]);
  assertEquals(parsed.error.retryable, true);
});

Deno.test("note always writes, independent of --json", () => {
  const { lines, write } = capture();
  note("fetching…", write);
  assertEquals(lines, ["fetching…"]);
});
