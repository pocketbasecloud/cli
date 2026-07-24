import { assertEquals, assertRejects } from "@std/assert";
import { extractEntry } from "../../../src/local/unzip.ts";
import { buildZip, setCentralMethod } from "../../mocks/zip.mock.ts";
import { CliError } from "../../../src/errors.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

Deno.test("extractEntry inflates a deflated entry", async () => {
  const body = enc.encode("BINARY-CONTENT-".repeat(500));
  const zip = await buildZip([{ name: "pocketbase", body }]);
  const got = await extractEntry(zip, "pocketbase");
  assertEquals(dec.decode(got), dec.decode(body));
});

Deno.test("extractEntry reads a stored (uncompressed) entry", async () => {
  const zip = await buildZip([
    { name: "LICENSE.md", body: enc.encode("mit"), store: true },
  ]);
  assertEquals(dec.decode(await extractEntry(zip, "LICENSE.md")), "mit");
});

Deno.test("extractEntry picks the right entry out of many", async () => {
  const body = enc.encode("the-real-binary");
  const zip = await buildZip([
    { name: "CHANGELOG.md", body: enc.encode("notes") },
    { name: "pocketbase", body },
    { name: "LICENSE.md", body: enc.encode("mit"), store: true },
  ]);
  assertEquals(
    dec.decode(await extractEntry(zip, "pocketbase")),
    "the-real-binary",
  );
});

Deno.test("extractEntry rejects a missing entry", async () => {
  const zip = await buildZip([{ name: "CHANGELOG.md", body: enc.encode("x") }]);
  const e = await assertRejects(
    () => extractEntry(zip, "pocketbase"),
    CliError,
  );
  assertEquals((e as Error).message.includes("pocketbase"), true);
});

Deno.test("extractEntry rejects a buffer that is not a zip", async () => {
  await assertRejects(
    () => extractEntry(enc.encode("not a zip at all"), "pocketbase"),
    CliError,
  );
});

Deno.test("extractEntry rejects an unsupported compression method", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: enc.encode("x") }]);
  const patched = setCentralMethod(zip, "pocketbase", 99);
  const e = await assertRejects(
    () => extractEntry(patched, "pocketbase"),
    CliError,
  );
  assertEquals((e as Error).message.includes("99"), true);
});
