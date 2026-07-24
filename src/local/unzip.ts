import { CliError } from "../errors.ts";

const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD_MIN_SIZE = 22;

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BufferSource]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Extracts a single named entry from a zip archive.
 *
 * Supports stored (method 0) and deflated (method 8) entries, which is
 * everything PocketBase's release archives use. Zip64 is not supported; the
 * assets are ~15MB, far below the 4GB threshold that would require it.
 */
export async function extractEntry(
  zip: Uint8Array,
  name: string,
): Promise<Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  // The end-of-central-directory record sits at the end, after a variable
  // length comment, so scan backwards for its signature.
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
      1,
    );
  }

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CD_SIG) {
      throw new CliError(
        "Corrupt zip archive (bad central directory entry).",
        1,
      );
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);

    if (dec.decode(zip.subarray(p + 46, p + 46 + nameLen)) === name) {
      // Read the name/extra lengths from the local header rather than reusing
      // the central directory's — they are allowed to differ, and the data
      // offset depends on the local header's values.
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return data.slice();
      if (method === 8) return await inflateRaw(data);
      throw new CliError(
        `Unsupported zip compression method ${method} for "${name}".`,
        1,
      );
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  throw new CliError(`"${name}" not found in the downloaded archive.`, 1);
}
