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
