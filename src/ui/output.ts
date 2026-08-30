import { emit } from "../envelope.ts";

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
  emit(json, rows, () => renderTable(rows, cols), write);
}

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

export function printDetail<T>(
  value: T,
  fields: Field<T>[],
  json: boolean,
  write: (s: string) => void = console.log,
): void {
  emit(json, value, () => renderDetail(value, fields), write);
}

export function describePlan(plan: string | undefined): string {
  return plan && plan.length > 0 ? plan : "none (no active subscription)";
}
