/**
 * Whether an archive carries anything the platform's PocketBase upload route
 * would install — asked *before* uploading, so a wrong archive costs a message
 * rather than a round trip and an errored instance.
 *
 * The rule here mirrors the agent's (`server-agent/src/services/pocketbase/
 * files.service.ts`, plus the root-level sanitize in `zip-extraction.service`)
 * and `backend-extension/src/services/archive-hooks.service.ts`, which reads
 * `pb_hooks` out of the archive) and must keep mirroring it: being stricter
 * blocks an archive the platform would have taken, being more lenient
 * re-creates the failure this exists to prevent. Separate runtimes, no shared
 * package — both copies are tested against the same shapes. The portal
 * deliberately holds no copy: it renders the platform's verdict rather than
 * forming its own.
 */

/**
 * The directories an upload installs. `pb_hooks` goes to the platform's hook
 * collection (and from there to the instance), the other two straight to disk.
 */
export const PB_UPLOADABLE_DIRS = [
  "pb_hooks",
  "pb_migrations",
  "pb_public",
] as const;

/**
 * Belongs to an instance, so a lone one of these is the archive's payload
 * (which the route then refuses) rather than a wrapper folder to descend into.
 */
const PB_INSTANCE_DIRS = [...PB_UPLOADABLE_DIRS, "pb_data"];

/** Deleted from the archive root before the agent looks at it. */
const STRIPPED_AT_ROOT = [
  ".git",
  "__MACOSX",
  ".DS_Store",
  "node_modules",
  "pb_data",
];

export type PbArchiveShape = {
  /** Which uploadable directories the platform would install. */
  uploadable: string[];
  /** What the archive holds where they were looked for, for the message. */
  found: string[];
};

/**
 * Splits `names` (archive entry paths) into the directories the platform would
 * install and what it would skip.
 *
 * Directory entries are optional in a zip — most writers, including this CLI's
 * own, record only files and leave parents implied — so a directory is
 * recognised by a name having something after it, not by an entry of its own.
 */
export function pbArchiveShape(names: string[]): PbArchiveShape {
  const atRoot = level(names, "");
  const shape = classify(atRoot);
  if (shape.uploadable.length > 0) return shape;

  // A zip built from a project directory wraps everything in one folder. A
  // lone pb_hooks/pb_data is the payload, not a wrapper.
  const [only] = shape.found;
  if (shape.found.length !== 1 || PB_INSTANCE_DIRS.includes(only)) return shape;

  const nested = classify(level(names, `${only}/`));
  return nested.uploadable.length > 0 ? nested : shape;
}

/** Entry names one level below `prefix`, de-duplicated, sanitized at the root. */
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

    // `a/` is a directory entry; `a/b` implies `a` is one. Either sighting
    // wins over a plain file entry of the same name.
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

/**
 * Entry names in a zip, read from its central directory, or `null` when the
 * bytes are not a zip at all.
 *
 * Names only: an archive can be checked without inflating a single entry.
 */
export function zipEntryNames(zip: Uint8Array): string[] | null {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  if (zip.byteLength < 22) return null;

  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The record sits at the end, after a variable-length comment, so scan back.
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
