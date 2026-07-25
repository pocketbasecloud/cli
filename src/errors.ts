/**
 * PocketBase reports *why* a request failed one field at a time, in
 * `response.data` — the top-level `message` is always something uninformative
 * like "Failed to create record.". Both clients need the same unpacking, so it
 * lives here: `detail` for the human sentence, `fields` for callers that react
 * to a specific code.
 */
export function fieldErrors(
  data: unknown,
): { detail: string; fields?: Record<string, string> } {
  const entries = Object.entries(
    (data ?? {}) as Record<string, { code?: string; message?: string }>,
  );
  if (entries.length === 0) return { detail: "" };
  return {
    detail: entries
      .map(([f, v]) => `${f}: ${v?.message ?? v?.code ?? "invalid"}`)
      .join("; "),
    fields: Object.fromEntries(entries.map(([f, v]) => [f, v?.code ?? ""])),
  };
}

export class CliError extends Error {
  exitCode: number;
  /**
   * PocketBase's per-field validation codes (field -> code), when the platform
   * sent any. Kept structured so a caller can react to one — a taken subdomain
   * is retryable, everything else is not.
   */
  fields?: Record<string, string>;
  constructor(message: string, exitCode = 1, fields?: Record<string, string>) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.fields = fields;
  }
}
