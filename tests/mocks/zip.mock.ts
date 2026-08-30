const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BufferSource]).stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type ZipEntry = { name: string; body: Uint8Array; store?: boolean };

export async function buildZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const method = e.store ? 0 : 8;
    const data = e.store ? e.body : await deflateRaw(e.body);

    const lh = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, e.body.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    lh.set(data, 30 + nameBytes.length);
    locals.push(lh);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, CD_SIG, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, e.body.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centrals.push(ch);

    offset += lh.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function setCentralMethod(
  zip: Uint8Array,
  name: string,
  method: number,
): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  const dec = new TextDecoder();
  for (let i = 0; i < out.length - 4; i++) {
    if (view.getUint32(i, true) !== CD_SIG) continue;
    const nameLen = view.getUint16(i + 28, true);
    if (dec.decode(out.subarray(i + 46, i + 46 + nameLen)) === name) {
      view.setUint16(i + 10, method, true);
    }
  }
  return out;
}
