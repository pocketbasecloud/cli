import { CliError } from "../errors.ts";

const BLOCK = 512;

const NAME_OFF = 0, NAME_LEN = 100;
const SIZE_OFF = 124, SIZE_LEN = 12;
const TYPE_OFF = 156;
const PREFIX_OFF = 345, PREFIX_LEN = 155;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BufferSource]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function str(block: Uint8Array, off: number, len: number): string {
  const raw = block.subarray(off, off + len);
  let end = raw.indexOf(0);
  if (end < 0) end = raw.length;
  return new TextDecoder().decode(raw.subarray(0, end)).trim();
}

function octal(block: Uint8Array, off: number, len: number): number {
  const s = str(block, off, len).replace(/[^0-7]/g, "");
  return s ? parseInt(s, 8) : 0;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((b) => b === 0);
}

export async function extractFromTarGz(
  archive: Uint8Array,
  name: string,
): Promise<Uint8Array> {
  let tar: Uint8Array;
  try {
    tar = await gunzip(archive);
  } catch (e) {
    throw new CliError(
      `Downloaded file is not a valid gzip archive: ${
        e instanceof Error ? e.message : String(e)
      }`);
  }

  for (let p = 0; p + BLOCK <= tar.length;) {
    const header = tar.subarray(p, p + BLOCK);
    if (isZeroBlock(header)) break;

    const prefix = str(header, PREFIX_OFF, PREFIX_LEN);
    const base = str(header, NAME_OFF, NAME_LEN);
    const entry = (prefix ? `${prefix}/${base}` : base).replace(/^\.\//, "");
    const size = octal(header, SIZE_OFF, SIZE_LEN);
    const type = String.fromCharCode(header[TYPE_OFF]);
    const start = p + BLOCK;

    if (entry === name && (type === "0" || type === "\0")) {
      if (start + size > tar.length) {
        throw new CliError(
          `Corrupt archive: "${name}" is truncated.`);
      }
      return tar.slice(start, start + size);
    }

    p = start + Math.ceil(size / BLOCK) * BLOCK;
  }

  throw new CliError(`"${name}" not found in the downloaded archive.`);
}
