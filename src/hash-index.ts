import { dirname, join } from "@std/path";
import { configPath } from "./config.ts";
import { sha256Hex } from "./hash.ts";

const RACY_WINDOW_MS = 2000;

type Row = { size: number; mtimeMs: number; hash: string; at: number };

export type HashableFile = {
  name: string;
  size: number;
  mtimeMs: number;
  read: () => Promise<Uint8Array>;
};

export class HashIndex {
  private readonly seen: Record<string, Row> = {};
  private changed = false;

  private constructor(
    private readonly path: string | null,
    private readonly rows: Record<string, Row>,
    private readonly now: () => number,
  ) {}

  static memory(now: () => number = Date.now): HashIndex {
    return new HashIndex(null, {}, now);
  }

  static async load(
    cwd: string,
    env: Record<string, string | undefined> = Deno.env.toObject(),
    now: () => number = Date.now,
  ): Promise<HashIndex> {
    const key = (await sha256Hex(new TextEncoder().encode(cwd))).slice(0, 32);
    const path = join(dirname(configPath(env)), "hashes", `${key}.json`);
    const rows = await Deno.readTextFile(path)
      .then((text) => JSON.parse(text) as Record<string, Row>)
      .catch(() => ({}));
    return new HashIndex(path, rows, now);
  }

  async hashOf(file: HashableFile): Promise<string> {
    const row = this.rows[file.name];
    const trusted = row && file.mtimeMs > 0 && row.size === file.size &&
      row.mtimeMs === file.mtimeMs && file.mtimeMs < row.at - RACY_WINDOW_MS;
    if (trusted) {
      this.seen[file.name] = row;
      return row.hash;
    }
    const hash = await sha256Hex(await file.read());
    this.seen[file.name] = {
      size: file.size,
      mtimeMs: file.mtimeMs,
      hash,
      at: this.now(),
    };
    this.changed = true;
    return hash;
  }

  async save(): Promise<void> {
    const pruned = Object.keys(this.rows).length !==
      Object.keys(this.seen).length;
    if (!this.path || (!this.changed && !pruned)) return;
    await Deno.mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(temp, JSON.stringify(this.seen));
    await Deno.rename(temp, this.path);
  }
}
