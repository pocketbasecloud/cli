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

/**
 * Wrappers that exist only to say "something failed", which the caller already
 * knows from the status code. Skipped in favour of whatever sits underneath;
 * used as a last resort if nothing else survives.
 */
const GENERIC_MESSAGES = new Set([
  // PocketBase's own wrappers: every rejected write carries one of these, with
  // the actual reason in the per-field map underneath.
  "Failed to create record.",
  "Failed to update record.",
  "Failed to delete record.",
  "Something went wrong while processing your request.",
  "Internal server error",
  "Unknown error",
  "Failed to write hooks",
  "Failed to set env vars",
  "Failed to delete env vars",
  "Failed to list env vars",
]);

/** Keys the platform's routes put a reason under, most specific first. */
const REASON_KEYS = ["details", "error_message", "message", "error"] as const;

/** The reason-bearing strings on one level of an error body. */
function stringCandidates(obj: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of REASON_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      found.push(value);
    } else if (Array.isArray(value)) {
      const items = value.filter((v): v is string =>
        typeof v === "string" && v.length > 0
      );
      if (items.length > 0) found.push(items.join("; "));
    }
  }
  return found;
}

function reasonFrom(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;

  const details = obj.details as Record<string, unknown> | undefined;
  const nested = details?.data as Record<string, unknown> | undefined;

  const candidates: string[] = [];

  // Most specific first: a rejected field beats any sentence above it.
  const fieldDetail = pocketBaseFieldDetail(obj);
  if (fieldDetail) candidates.push(fieldDetail);

  // Then this level, then each layer that re-wrapped it — a nested body's own
  // message is still a reason when it carries no field errors.
  for (const level of [obj, details, nested]) {
    if (level && typeof level === "object" && !Array.isArray(level)) {
      candidates.push(...stringCandidates(level));
    }
  }

  return candidates.find((c) => !GENERIC_MESSAGES.has(c)) ?? candidates[0];
}

/**
 * PocketBase's per-field validation errors, from whichever depth they arrived
 * at.
 *
 * The shape is always `{ data: { <field>: { code, message, params } } }`, but
 * how deeply it is buried depends on how many layers re-wrapped it on the way
 * out. An over-long hook has been seen arriving as `details.data.data.content`
 * — the PocketBase response body nested inside a `details.data` envelope —
 * with nothing but "Failed to create record." above it. Checking one fixed
 * depth is how that reached a user as seven words naming neither the field nor
 * the limit.
 *
 * A container only counts when its `data` actually holds field errors, so the
 * intermediate `{ data, message, status }` envelope is stepped over rather than
 * read as three fields named "data", "message" and "status".
 */
function pocketBaseFieldDetail(body: Record<string, unknown>): string {
  const details = body.details as Record<string, unknown> | undefined;
  const nested = details?.data as Record<string, unknown> | undefined;

  for (
    const container of [
      body,
      details,
      nested,
      nested?.data as
        | Record<string, unknown>
        | undefined,
    ]
  ) {
    if (!container || typeof container !== "object") continue;
    const fields = container.data;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      continue;
    }

    const parts: string[] = [];
    for (const [field, detail] of Object.entries(fields)) {
      if (!detail || typeof detail !== "object") continue;
      const { message, code, params } = detail as {
        message?: unknown;
        code?: unknown;
        params?: Record<string, unknown>;
      };
      if (typeof message !== "string" || !message) continue;

      // The limit is read from PocketBase's own `params`, so raising the
      // field's `max` cannot leave this quoting the old number.
      const max = code === "validation_max_text_constraint"
        ? Number(params?.max)
        : NaN;
      parts.push(
        Number.isFinite(max)
          ? `${field}: must be no more than ${
            max.toLocaleString("en-US")
          } characters`
          : `${field}: ${message}`,
      );
    }
    if (parts.length > 0) return parts.join("; ");
  }

  return "";
}

/**
 * Turns a failed HTTP response into an error that repeats what the platform
 * said.
 *
 * The routes answer with the useful sentence one level down — `details` on
 * PocketBase's custom routes, `error` on backend-extension's — and reporting
 * only the status code, which is what most call sites used to do, throws that
 * away and leaves the user with a bare number to act on. The body is read
 * here, once, so no caller has to remember to.
 *
 * Exit codes follow the CLI's convention: 4 means "log in again", 3 means "you
 * may not do this", 1 is everything else.
 */
export async function httpError(
  res: Response,
  action: string,
): Promise<CliError> {
  const body = await res.json().catch(() => null);
  const reason = reasonFrom(body) ??
    (res.status === 401
      ? "not authenticated — run `pb cloud login`"
      : res.status === 403
      ? "permission denied"
      : undefined);

  const exitCode = res.status === 401 ? 4 : res.status === 403 ? 3 : 1;

  return new CliError(
    reason
      ? `${action} failed (${res.status}): ${reason}`
      : `${action} failed (${res.status}).`,
    exitCode,
  );
}
