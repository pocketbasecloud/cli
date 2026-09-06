import { VERSION } from "./version.ts";

export type ErrorCode =
  | "USAGE"
  | "UNKNOWN_FLAG"
  | "MISSING_ARG"
  | "NO_TARGET"
  | "INVALID_VALUE"
  | "NOT_FOUND"
  | "NOT_AUTHENTICATED"
  | "FORBIDDEN"
  | "UPGRADE_REQUIRED"
  | "PLAN_LIMIT"
  | "CONFLICT"
  | "PLATFORM_ERROR"
  | "NETWORK_ERROR"
  | "INTERNAL"
  | "TIMEOUT";

export const EXIT_CODES = {
  OK: 0,
  USAGE: 2,
  NOT_FOUND: 3,
  AUTH: 4,
  FORBIDDEN: 5,
  CONFLICT: 6,
  PLATFORM: 7,
  TIMEOUT: 8,
} as const;

const EXIT_CODE_BY_ERROR_CODE: Record<ErrorCode, number> = {
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

const HINT_BY_ERROR_CODE: Record<ErrorCode, string> = {
  USAGE: "Run the command with --help to see its usage.",
  UNKNOWN_FLAG: "Run the command with --help to see its accepted flags.",
  MISSING_ARG: "Run the command with --help to see its required arguments.",
  NO_TARGET: "Pass --project or --profile, or run `pbc admin use <url>` first.",
  INVALID_VALUE: "Run the command with --help to see accepted values.",
  NOT_FOUND: "List what exists with the resource's `ls` command.",
  NOT_AUTHENTICATED: "pbc login",
  FORBIDDEN: "This action may need different account permissions.",
  UPGRADE_REQUIRED: "Run `pbc self upgrade` to install the required version.",
  PLAN_LIMIT: "pbc plan",
  CONFLICT:
    "The resource is in a state that blocks this action — check its `info` command.",
  PLATFORM_ERROR:
    "Retry, and check https://status.pocketbasecloud.com if it persists.",
  NETWORK_ERROR: "Check your connection and retry.",
  INTERNAL: "Retry; if it persists, this is a CLI bug.",
  TIMEOUT: "Check the resource's `info` command for its current status.",
};

const RETRYABLE_BY_ERROR_CODE: Partial<Record<ErrorCode, boolean>> = {
  TIMEOUT: true,
  NETWORK_ERROR: true,
  PLATFORM_ERROR: true,
};

export type CliErrorOptions = {
  code?: ErrorCode;
  hint?: string;
  docs?: string;
  retryable?: boolean;
  fields?: Record<string, string>;
};

export class CliError extends Error {
  code: ErrorCode;
  hint: string;
  docs?: string;
  retryable: boolean;
  fields?: Record<string, string>;
  constructor(message: string, opts: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.code = opts.code ?? "PLATFORM_ERROR";
    this.hint = opts.hint ?? HINT_BY_ERROR_CODE[this.code];
    this.docs = opts.docs;
    this.retryable = opts.retryable ?? (RETRYABLE_BY_ERROR_CODE[this.code] ?? false);
    this.fields = opts.fields;
  }
  get exitCode(): number {
    return EXIT_CODE_BY_ERROR_CODE[this.code];
  }
}

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

const GENERIC_MESSAGES = new Set([
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

const REASON_KEYS = ["details", "error_message", "message", "error"] as const;

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

  const fieldDetail = pocketBaseFieldDetail(obj);
  if (fieldDetail) candidates.push(fieldDetail);

  for (const level of [obj, details, nested]) {
    if (level && typeof level === "object" && !Array.isArray(level)) {
      candidates.push(...stringCandidates(level));
    }
  }

  return candidates.find((c) => !GENERIC_MESSAGES.has(c)) ?? candidates[0];
}

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

export function codeFromStatus(status: number): ErrorCode | undefined {
  switch (status) {
    case 401:
      return "NOT_AUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 413:
      return "INVALID_VALUE";
    case 426:
      return "UPGRADE_REQUIRED";
    default:
      return status >= 500 ? "PLATFORM_ERROR" : undefined;
  }
}

export function upgradeRequiredError(
  action: string,
  status: number,
  body: unknown,
  current: string,
): CliError {
  const obj = (body ?? {}) as Record<string, unknown>;
  const min = typeof obj.minCliVersion === "string" && obj.minCliVersion
    ? obj.minCliVersion
    : undefined;
  const reason = typeof obj.error === "string" && obj.error
    ? obj.error
    : typeof obj.message === "string" && obj.message
    ? obj.message
    : undefined;
  const detail = min
    ? `pbc ${current} is too old (minimum: ${min}).`
    : `pbc ${current} is too old for this operation.`;
  const upgradeLine = "Run `pbc self upgrade`.";
  const tail = reason && !reason.includes("pbc self upgrade")
    ? ` ${reason}`
    : "";
  return new CliError(
    `${action} failed (${status}): ${detail} ${upgradeLine}${tail}`,
    { code: "UPGRADE_REQUIRED" },
  );
}

export async function httpError(
  res: Response,
  action: string,
  current: string = VERSION,
): Promise<CliError> {
  const body = await res.json().catch(() => null);
  if (res.status === 426) {
    return upgradeRequiredError(action, res.status, body, current);
  }
  const reason = reasonFrom(body) ??
    (res.status === 401
      ? "not authenticated — run `pbc login`"
      : res.status === 403
      ? "permission denied"
      : undefined);

  const code = codeFromStatus(res.status);

  return new CliError(
    reason
      ? `${action} failed (${res.status}): ${reason}`
      : `${action} failed (${res.status}).`,
    code ? { code } : {},
  );
}
