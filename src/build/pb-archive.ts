export const PB_UPLOADABLE_DIRS = [
  "pb_hooks",
  "pb_migrations",
  "pb_public",
] as const;

const PB_INSTANCE_DIRS = [...PB_UPLOADABLE_DIRS, "pb_data"];

const STRIPPED_AT_ROOT = [
  ".git",
  "__MACOSX",
  ".DS_Store",
  "node_modules",
  "pb_data",
];

export type PbArchiveShape = {
  uploadable: string[];
  found: string[];
};

export function pbArchiveShape(names: string[]): PbArchiveShape {
  const atRoot = level(names, "");
  const shape = classify(atRoot);
  if (shape.uploadable.length > 0) return shape;

  const [only] = shape.found;
  if (shape.found.length !== 1 || PB_INSTANCE_DIRS.includes(only)) return shape;

  const nested = classify(level(names, `${only}/`));
  return nested.uploadable.length > 0 ? nested : shape;
}

function level(names: string[], prefix: string): Map<string, boolean> {
  const entries = new Map<string, boolean>();
  for (const raw of names) {
    const name = raw.replace(/^\.\//, "");
    if (!name.startsWith(prefix)) continue;

    const rest = name.slice(prefix.length);
    const slash = rest.indexOf("/");
    const segment = slash < 0 ? rest : rest.slice(0, slash);
    if (!segment) continue;
    if (prefix === "" && STRIPPED_AT_ROOT.includes(segment)) continue;

    const isDirectory = slash >= 0;
    entries.set(segment, (entries.get(segment) ?? false) || isDirectory);
  }
  return entries;
}

function classify(entries: Map<string, boolean>): PbArchiveShape {
  const uploadable: string[] = [];
  for (const [name, isDirectory] of entries) {
    if (isDirectory && (PB_UPLOADABLE_DIRS as readonly string[]).includes(name)) {
      uploadable.push(name);
    }
  }
  return { uploadable: uploadable.sort(), found: [...entries.keys()].sort() };
}

export function zipEntryNames(zip: Uint8Array): string[] | null {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  if (zip.byteLength < 22) return null;

  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const names: string[] = [];

  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.byteLength || view.getUint32(p, true) !== CD_SIG) {
      return null;
    }
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    names.push(dec.decode(zip.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
