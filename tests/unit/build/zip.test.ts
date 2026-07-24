import { assertEquals, assertRejects } from "@std/assert";
import { crc32, writeZip } from "../../../src/build/zip.ts";
import { extractEntry } from "../../../src/local/unzip.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

Deno.test("crc32 matches the known IEEE check value", () => {
  // The standard "123456789" check vector for CRC-32/ISO-HDLC.
  assertEquals(crc32(enc("123456789")), 0xcbf43926);
  assertEquals(crc32(new Uint8Array(0)), 0);
});

Deno.test("writeZip round-trips through extractEntry", async () => {
  const zip = await writeZip([
    { name: "index.html", body: enc("<h1>hi</h1>") },
    { name: "assets/app.js", body: enc("console.log(1)") },
  ]);
  assertEquals(dec(await extractEntry(zip, "index.html")), "<h1>hi</h1>");
  assertEquals(dec(await extractEntry(zip, "assets/app.js")), "console.log(1)");
});

Deno.test("writeZip round-trips an empty file", async () => {
  const zip = await writeZip([{ name: "empty", body: new Uint8Array(0) }]);
  assertEquals((await extractEntry(zip, "empty")).length, 0);
});

Deno.test("writeZip round-trips a body larger than one deflate chunk", async () => {
  // Highly compressible, so this exercises the deflate path rather than the
  // stored fallback.
  const body = enc("abcdefgh".repeat(80_000)); // 640 KB
  const zip = await writeZip([{ name: "big.txt", body }]);
  const out = await extractEntry(zip, "big.txt");
  assertEquals(out.length, body.length);
  assertEquals(out[0], body[0]);
  assertEquals(out[out.length - 1], body[body.length - 1]);
  // It must actually have compressed, or the fallback is masking a bug.
  assertEquals(zip.length < body.length, true);
});

Deno.test("writeZip stores incompressible data rather than growing it", async () => {
  const body = crypto.getRandomValues(new Uint8Array(4096));
  const zip = await writeZip([{ name: "rand.bin", body }]);
  assertEquals(await extractEntry(zip, "rand.bin"), body);
  // Stored: the archive is the payload plus headers, not payload + deflate
  // overhead on top.
  assertEquals(zip.length < body.length + 200, true);
});

Deno.test("writeZip round-trips a UTF-8 entry name", async () => {
  const zip = await writeZip([{ name: "héllo/wörld.txt", body: enc("ok") }]);
  assertEquals(dec(await extractEntry(zip, "héllo/wörld.txt")), "ok");
});

Deno.test("writeZip produces an archive that reports missing entries", async () => {
  const zip = await writeZip([{ name: "a.txt", body: enc("a") }]);
  await assertRejects(() => extractEntry(zip, "b.txt"), Error, "not found");
});
