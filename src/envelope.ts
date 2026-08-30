import type { CliError } from "./errors.ts";

export const SCHEMA_VERSION = 1;

export function emit(
  json: boolean,
  data: unknown,
  human: string | (() => string),
  write: (s: string) => void = console.log,
): void {
  if (json) {
    write(JSON.stringify({ ok: true, schemaVersion: SCHEMA_VERSION, data }));
  } else {
    write(typeof human === "function" ? human() : human);
  }
}

export function emitError(
  json: boolean,
  err: CliError,
  write: (s: string) => void = console.log,
): void {
  if (!json) return;
  write(JSON.stringify({
    ok: false,
    schemaVersion: SCHEMA_VERSION,
    error: {
      code: err.code,
      message: err.message,
      hint: err.hint,
      ...(err.docs ? { docs: err.docs } : {}),
      retryable: err.retryable,
    },
  }));
}

export function note(text: string, write: (s: string) => void = console.error): void {
  write(text);
}
