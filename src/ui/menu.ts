import { CliError } from "../errors.ts";
import { pauseProgress } from "./progress.ts";
import type { PromptIO, PromptOpts } from "./prompt.ts";

export type MenuRow = {
  name: string;
  id: string;
  status?: string;
  project?: string;
  updated?: string;
};

export type MenuChoice<T> = { create: true } | { create: false; item: T };

const VIEWPORT = 12;
const FILTER_MODE_ABOVE = 50;

function stdinIO(): PromptIO {
  const dec = new TextDecoder();
  return {
    read: async () => {
      const buf = new Uint8Array(1024);
      const n = await Deno.stdin.read(buf);
      return n === null
        ? null
        : dec.decode(buf.subarray(0, n)).replace(/\r?\n$/, "");
    },
    write: (s) => Deno.stderr.writeSync(new TextEncoder().encode(s)),
    isTTY: Deno.stdin.isTerminal(),
  };
}

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const then = Date.parse(iso.replace(" ", "T"));
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  const units: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4.35, "w"],
    [12, "mo"],
  ];
  let value = secs;
  let unit = "s";
  for (const [size, next] of units) {
    if (value < size) break;
    value /= size;
    unit = next;
  }
  return `${Math.floor(value)}${unit} ago`;
}

function plural(label: string, n: number): string {
  return n === 1 ? label : `${label}s`;
}

export async function chooseFromMenu<T>(o: {
  items: readonly T[];
  label: string;
  verb?: string;
  allowCreate: boolean;
  key: (t: T) => MenuRow;
  opts: PromptOpts;
}): Promise<MenuChoice<T>> {
  const io = o.opts.io ?? stdinIO();
  if (o.opts.noInput || !io.isTTY) {
    throw new CliError(
      "A target is required but this is running non-interactively.",
      { code: "USAGE" },
    );
  }
  const rows = o.items.map((item) => ({ item, row: o.key(item) }));
  const multiProject =
    new Set(rows.map((r) => r.row.project ?? "")).size > 1 &&
    rows.some((r) => r.row.project);

  const matches = (r: MenuRow, f: string) =>
    r.name.toLowerCase().includes(f) ||
    (r.project ?? "").toLowerCase().includes(f);

  let filter = "";
  let firstPass = true;

  return await pauseProgress(async () => {
    while (true) {
      if (
        firstPass && !filter && o.items.length > FILTER_MODE_ABOVE
      ) {
        io.write(
          `${o.items.length} ${plural(o.label, o.items.length)} — type to ` +
            `filter, or press enter for all:\n> `,
        );
        filter = ((await io.read()) ?? "").trim().toLowerCase();
      }
      firstPass = false;

      const shown = filter
        ? rows.filter((r) => matches(r.row, filter))
        : rows;
      if (filter && shown.length === 0) {
        io.write(`No ${o.label} matches "${filter}". Try again.\n> `);
        const next = await io.read();
        if (next === null) {
          throw new CliError("No selection made.", { code: "USAGE" });
        }
        filter = next.trim().toLowerCase();
        continue;
      }

      const capped = shown.slice(0, VIEWPORT);
      const hidden = shown.length - capped.length;

      io.write(
        `${o.verb ?? "Select"} (${shown.length} ${
          plural(o.label, shown.length)
        }):\n`,
      );
      const numbered: (T | "create")[] = [];
      let n = 0;
      if (o.allowCreate) {
        n++;
        numbered.push("create");
        io.write(`  ${n}) + Create a new ${o.label}…\n`);
      }

      let lastGroup: string | undefined;
      for (const { item, row } of capped) {
        if (multiProject && row.project && row.project !== lastGroup) {
          lastGroup = row.project;
          io.write(`  ${row.project}\n`);
        }
        n++;
        numbered.push(item);
        const meta = [row.status, relativeTime(row.updated)].filter(Boolean)
          .join(" · ");
        io.write(
          `  ${n}) ${row.name}${meta ? `   ${meta}` : ""}\n`,
        );
      }
      if (hidden > 0) {
        io.write(`  …${hidden} more — type to filter\n`);
      }
      io.write("> ");

      const raw = await io.read();
      if (raw === null) {
        throw new CliError("No selection made.", { code: "USAGE" });
      }
      const answer = raw.trim();
      const idx = Number(answer);
      if (
        Number.isInteger(idx) && idx >= 1 && idx <= numbered.length
      ) {
        const picked = numbered[idx - 1];
        return picked === "create"
          ? { create: true }
          : { create: false, item: picked };
      }
      filter = answer.toLowerCase();
    }
  });
}
