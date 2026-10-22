import { CliError } from "../errors.ts";

const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD_MIN_SIZE = 22;

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BufferSource]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function centralDirectory(zip: Uint8Array): CentralEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  let eocd = -1;
  for (let i = zip.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new CliError(
      "Downloaded file is not a zip archive (no end-of-central-directory record).",
    );
  }

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries: CentralEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CD_SIG) {
      throw new CliError(
        "Corrupt zip archive (bad central directory entry).",
      );
    }
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    entries.push({
      name: dec.decode(zip.subarray(p + 46, p + 46 + nameLen)),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      localOffset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(
  zip: Uint8Array,
  entry: CentralEntry,
): Promise<Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const lNameLen = view.getUint16(entry.localOffset + 26, true);
  const lExtraLen = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + lNameLen + lExtraLen;
  const data = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.slice();
  if (entry.method === 8) return await inflateRaw(data);
  throw new CliError(
    `Unsupported zip compression method ${entry.method} for "${entry.name}".`,
  );
}

export async function extractEntry(
  zip: Uint8Array,
  name: string,
): Promise<Uint8Array> {
  const entry = centralDirectory(zip).find((e) => e.name === name);
  if (!entry) {
    throw new CliError(`"${name}" not found in the downloaded archive.`);
  }
  return await readEntry(zip, entry);
}

export async function extractFiles(
  zip: Uint8Array,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const entry of centralDirectory(zip)) {
    if (entry.name.endsWith("/")) continue;
    files.set(entry.name, await readEntry(zip, entry));
  }
  return files;
}
