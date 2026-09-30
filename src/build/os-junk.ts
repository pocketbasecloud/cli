const OS_JUNK_NAMES = new Set([
  ".DS_Store",
  "__MACOSX",
  ".AppleDouble",
  ".LSOverride",
  ".Spotlight-V100",
  ".Trashes",
  ".fseventsd",
  ".TemporaryItems",
  ".DocumentRevisions-V100",
  "Icon\r",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".directory",
]);

const CASE_INSENSITIVE_OS_JUNK = new Set([
  "thumbs.db",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  "desktop.ini",
]);

const OS_JUNK_PATTERN =
  /^(\._.+|\.Trash-\d+|\.fuse_hidden[0-9a-fA-F]+|\.nfs[0-9a-fA-F]{8,})$/;

export function isOsJunkName(name: string): boolean {
  return OS_JUNK_NAMES.has(name) ||
    CASE_INSENSITIVE_OS_JUNK.has(name.toLowerCase()) ||
    OS_JUNK_PATTERN.test(name);
}

export function isOsJunkPath(path: string): boolean {
  return path.split("/").some((segment) => segment && isOsJunkName(segment));
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const DESCRIPTOR_SIG = 0x08074b50;
const EOCD_SIZE = 22;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
const HAS_DATA_DESCRIPTOR = 0x0008;

type CentralRecord = {
  start: number;
  end: number;
  name: string;
  localOffset: number;
  compressedSize: number;
  flags: number;
};

function findEocd(view: DataView, length: number): number {
  for (let i = length - EOCD_SIZE; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

function readCentral(
  zip: Uint8Array,
  view: DataView,
  eocd: number,
): CentralRecord[] | null {
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === ZIP64_MARKER_16 || cdOffset === ZIP64_MARKER_32) return null;

  const decoder = new TextDecoder();
  const records: CentralRecord[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== CD_SIG) return null;
    const nameLength = view.getUint16(p + 28, true);
    const end = p + 46 + nameLength + view.getUint16(p + 30, true) +
      view.getUint16(p + 32, true);
    const compressedSize = view.getUint32(p + 20, true);
    const localOffset = view.getUint32(p + 42, true);
    if (
      end > eocd || compressedSize === ZIP64_MARKER_32 ||
      localOffset === ZIP64_MARKER_32
    ) {
      return null;
    }
    records.push({
      start: p,
      end,
      name: decoder.decode(zip.subarray(p + 46, p + 46 + nameLength)),
      localOffset,
      compressedSize,
      flags: view.getUint16(p + 8, true),
    });
    p = end;
  }
  return records;
}

function localRecordEnd(
  view: DataView,
  length: number,
  record: CentralRecord,
): number | null {
  const at = record.localOffset;
  if (at + 30 > length || view.getUint32(at, true) !== LOCAL_SIG) return null;
  const dataEnd = at + 30 + view.getUint16(at + 26, true) +
    view.getUint16(at + 28, true) + record.compressedSize;
  if (dataEnd > length) return null;
  if (!(record.flags & HAS_DATA_DESCRIPTOR)) return dataEnd;
  const signed = dataEnd + 4 <= length &&
    view.getUint32(dataEnd, true) === DESCRIPTOR_SIG;
  const end = dataEnd + (signed ? 16 : 12);
  return end <= length ? end : null;
}

export function stripOsJunkFromZip(
  zip: Uint8Array,
): { bytes: Uint8Array; removed: string[] } {
  const untouched = { bytes: zip, removed: [] };
  if (zip.byteLength < EOCD_SIZE) return untouched;
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEocd(view, zip.byteLength);
  if (eocd < 0) return untouched;

  const records = readCentral(zip, view, eocd);
  if (!records) return untouched;
  const kept = records.filter((r) => !isOsJunkPath(r.name));
  if (kept.length === records.length) return untouched;

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const record of kept) {
    const end = localRecordEnd(view, zip.byteLength, record);
    if (end === null) return untouched;
    const local = zip.subarray(record.localOffset, end);
    const central = zip.slice(record.start, record.end);
    new DataView(central.buffer).setUint32(42, offset, true);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const trailer = zip.slice(
    eocd,
    eocd + EOCD_SIZE + view.getUint16(eocd + 20, true),
  );
  const trailerView = new DataView(trailer.buffer);
  trailerView.setUint16(8, kept.length, true);
  trailerView.setUint16(10, kept.length, true);
  trailerView.setUint32(12, centralSize, true);
  trailerView.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + trailer.length);
  let at = 0;
  for (const part of [...locals, ...centrals, trailer]) {
    out.set(part, at);
    at += part.length;
  }
  return {
    bytes: out,
    removed: records.filter((r) => isOsJunkPath(r.name)).map((r) => r.name),
  };
}
