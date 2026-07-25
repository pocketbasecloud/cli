export type Column<T> = { header: string; get: (row: T) => string };

export function renderTable<T>(rows: T[], cols: Column<T>[]): string {
  const cells = rows.map((r) => cols.map((c) => c.get(r) ?? ""));
  const widths = cols.map((c, i) =>
    Math.max(c.header.length, ...cells.map((row) => row[i].length), 0)
  );
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  const line = (row: string[]) =>
    row.map((s, i) => pad(s, widths[i])).join("  ").trimEnd();
  return [line(cols.map((c) => c.header)), ...cells.map(line)].join("\n");
}

export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function printResult<T>(
  rows: T[],
  cols: Column<T>[],
  json: boolean,
  write: (s: string) => void = console.log,
): void {
  write(json ? renderJson(rows) : renderTable(rows, cols));
}

/** One labelled line of a detail view. Rows with no value are dropped. */
export type Field<T> = { label: string; get: (v: T) => string | undefined };

export function renderDetail<T>(value: T, fields: Field<T>[]): string {
  const rows = fields
    .map((f) => [f.label, f.get(value)] as const)
    .filter((r): r is readonly [string, string] =>
      r[1] !== undefined && r[1] !== ""
    );
  const width = Math.max(...rows.map(([l]) => l.length), 0);
  return rows.map(([l, v]) => `${l.padEnd(width)}  ${v}`).join("\n");
}

/**
 * The single-record counterpart to `printResult`. Without it an `info` command
 * has no human output at all and falls back to dumping the raw record, which
 * buries the few fields that matter under storage internals.
 */
export function printDetail<T>(
  value: T,
  fields: Field<T>[],
  json: boolean,
  write: (s: string) => void = console.log,
): void {
  write(json ? renderJson(value) : renderDetail(value, fields));
}

/** A plan name for display; unsubscribed accounts carry an empty string. */
export function describePlan(plan: string | undefined): string {
  return plan && plan.length > 0 ? plan : "none (no active subscription)";
}
