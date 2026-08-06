const BLOCK = 512;

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BufferSource]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type TarEntry = {
  name: string;
  body: Uint8Array;
  /** ustar prefix field, for paths too long for the 100-byte name field. */
  prefix?: string;
  /** ustar type flag. "0" (regular) unless set; "5" is a directory. */
  type?: string;
};

function writeAscii(block: Uint8Array, off: number, s: string) {
  block.set(new TextEncoder().encode(s), off);
}

/**
 * Builds a structurally valid ustar archive, gzipped — the shape `tar -czf`
 * produces for the release tarballs. The header checksum field is left as
 * spaces: real tar writes a value there, but `extractFromTarGz` does not read
 * it, and archive integrity is covered by the SHA-256 check in upgrade.ts.
 */
export async function buildTarGz(entries: TarEntry[]): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];

  for (const e of entries) {
    const header = new Uint8Array(BLOCK);
    writeAscii(header, 0, e.name);
    writeAscii(header, 100, "0000644\0"); // mode
    writeAscii(header, 108, "0000000\0"); // uid
    writeAscii(header, 116, "0000000\0"); // gid
    writeAscii(header, 124, e.body.length.toString(8).padStart(11, "0") + "\0");
    writeAscii(header, 136, "00000000000\0"); // mtime
    writeAscii(header, 148, "        "); // checksum placeholder
    writeAscii(header, 156, e.type ?? "0");
    writeAscii(header, 257, "ustar\0");
    writeAscii(header, 263, "00");
    if (e.prefix) writeAscii(header, 345, e.prefix);
    blocks.push(header);

    const padded = new Uint8Array(Math.ceil(e.body.length / BLOCK) * BLOCK);
    padded.set(e.body);
    if (padded.length > 0) blocks.push(padded);
  }

  // Two zero blocks terminate the archive.
  blocks.push(new Uint8Array(BLOCK * 2));

  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return await gzip(out);
}
