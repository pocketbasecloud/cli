import { assertEquals } from "@std/assert";
import {
  isOsJunkName,
  stripOsJunkFromZip,
} from "../../../src/build/os-junk.ts";
import { zipEntryNames } from "../../../src/build/pb-archive.ts";
import { crc32, writeZip } from "../../../src/build/zip.ts";

const enc = new TextEncoder();

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  return await writeZip(
    Object.entries(files).map(([name, body]) => ({
      name,
      body: enc.encode(body),
    })),
  );
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readFiles(zip: Uint8Array): Promise<Record<string, string>> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.byteLength - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const name = new TextDecoder().decode(
      zip.subarray(p + 46, p + 46 + nameLength),
    );
    const local = view.getUint32(p + 42, true);
    const start = local + 30 + view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + size);
    const body = method === 8 ? await inflateRaw(raw) : raw;
    assertEquals(crc32(body), crc, `crc of ${name}`);
    files[name] = new TextDecoder().decode(body);
    p += 46 + nameLength + view.getUint16(p + 30, true) +
      view.getUint16(p + 32, true);
  }
  return files;
}

Deno.test("isOsJunkName recognises macOS, Windows and Linux metadata", () => {
  for (
    const name of [
      ".DS_Store",
      "__MACOSX",
      "._index.html",
      ".Spotlight-V100",
      "Thumbs.db",
      "thumbs.db",
      "Desktop.ini",
      "$RECYCLE.BIN",
      ".directory",
      ".Trash-1000",
      ".nfs000000001234abcd",
    ]
  ) {
    assertEquals(isOsJunkName(name), true, name);
  }
});

Deno.test("isOsJunkName keeps files that only look similar", () => {
  for (
    const name of [
      "index.html",
      ".env",
      ".gitignore",
      "_app.js",
      ".nfsrc",
      "thumbs.db.js",
      "Trash",
    ]
  ) {
    assertEquals(isOsJunkName(name), false, name);
  }
});

Deno.test("stripOsJunkFromZip removes metadata at every depth and keeps the rest intact", async () => {
  const body = "console.log('hello world'); ".repeat(40);
  const zip = await zipOf({
    "App/.DS_Store": "junk",
    "App/my-app/pb_hooks/main.pb.js": body,
    "App/my-app/pb_hooks/._main.pb.js": "junk",
    "App/my-app/pb_public/Thumbs.db": "junk",
    "App/my-app/pb_public/index.html": "<h1>hi</h1>",
    "__MACOSX/App/._my-app": "junk",
    "App/my-app/desktop.ini": "junk",
  });

  const { bytes, removed } = stripOsJunkFromZip(zip);

  assertEquals(removed.length, 5);
  assertEquals(await readFiles(bytes), {
    "App/my-app/pb_hooks/main.pb.js": body,
    "App/my-app/pb_public/index.html": "<h1>hi</h1>",
  });
});

Deno.test("stripOsJunkFromZip returns a clean archive unchanged", async () => {
  const zip = await zipOf({ "index.html": "<h1>hi</h1>" });
  const { bytes, removed } = stripOsJunkFromZip(zip);
  assertEquals(removed, []);
  assertEquals(bytes, zip);
});

Deno.test("stripOsJunkFromZip leaves bytes it cannot parse alone", () => {
  const garbage = enc.encode("not a zip archive at all, just text");
  assertEquals(stripOsJunkFromZip(garbage).bytes, garbage);
});

Deno.test("stripOsJunkFromZip output still lists through the platform's reader", async () => {
  const zip = await zipOf({ ".DS_Store": "junk", "a/b.txt": "b" });
  assertEquals(zipEntryNames(stripOsJunkFromZip(zip).bytes), ["a/b.txt"]);
});
