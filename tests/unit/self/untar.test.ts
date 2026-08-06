import { assertEquals, assertRejects } from "@std/assert";
import { extractFromTarGz } from "../../../src/self/untar.ts";
import { buildTarGz } from "../../mocks/tar.mock.ts";
import { CliError } from "../../../src/errors.ts";

const enc = new TextEncoder();
const BODY = enc.encode("#!/fake/pb binary\n");

Deno.test("extractFromTarGz returns the named entry's bytes", async () => {
  const tgz = await buildTarGz([{ name: "pb", body: BODY }]);
  assertEquals(await extractFromTarGz(tgz, "pb"), BODY);
});

Deno.test("extractFromTarGz skips past earlier entries to find the match", async () => {
  const tgz = await buildTarGz([
    { name: "README", body: enc.encode("a".repeat(1000)) },
    { name: "pb", body: BODY },
  ]);
  assertEquals(await extractFromTarGz(tgz, "pb"), BODY);
});

Deno.test("extractFromTarGz handles a body that exactly fills a block", async () => {
  const exact = new Uint8Array(512).fill(7);
  const tgz = await buildTarGz([
    { name: "pb", body: exact },
    { name: "after", body: enc.encode("x") },
  ]);
  assertEquals(await extractFromTarGz(tgz, "pb"), exact);
  assertEquals(await extractFromTarGz(tgz, "after"), enc.encode("x"));
});

Deno.test("extractFromTarGz handles an empty entry", async () => {
  const tgz = await buildTarGz([
    { name: "empty", body: new Uint8Array(0) },
    { name: "pb", body: BODY },
  ]);
  assertEquals(await extractFromTarGz(tgz, "pb"), BODY);
});

Deno.test("extractFromTarGz strips a leading ./ from entry names", async () => {
  const tgz = await buildTarGz([{ name: "./pb", body: BODY }]);
  assertEquals(await extractFromTarGz(tgz, "pb"), BODY);
});

Deno.test("extractFromTarGz joins the ustar prefix to the name", async () => {
  const tgz = await buildTarGz([
    { name: "pb", prefix: "bin", body: BODY },
  ]);
  assertEquals(await extractFromTarGz(tgz, "bin/pb"), BODY);
});

Deno.test("extractFromTarGz ignores a directory entry with the same name", async () => {
  const tgz = await buildTarGz([
    { name: "pb", type: "5", body: new Uint8Array(0) },
    { name: "pb", body: BODY },
  ]);
  assertEquals(await extractFromTarGz(tgz, "pb"), BODY);
});

Deno.test("extractFromTarGz treats a NUL type flag as a regular file", async () => {
  const tgz = await buildTarGz([{ name: "pb", type: "\0", body: BODY }]);
  assertEquals(await extractFromTarGz(tgz, "pb"), BODY);
});

Deno.test("extractFromTarGz rejects when the entry is absent", async () => {
  const tgz = await buildTarGz([{ name: "other", body: BODY }]);
  const e = await assertRejects(
    () => extractFromTarGz(tgz, "pb"),
    CliError,
  );
  assertEquals(e.message.includes('"pb" not found'), true);
});

Deno.test("extractFromTarGz rejects a file that is not gzip", async () => {
  await assertRejects(
    () => extractFromTarGz(enc.encode("<html>404</html>"), "pb"),
    CliError,
    "not a valid gzip archive",
  );
});
