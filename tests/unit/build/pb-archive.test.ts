import { assertEquals } from "@std/assert";
import {
  pbArchiveShape,
  zipEntryNames,
} from "../../../src/build/pb-archive.ts";
import { writeZip } from "../../../src/build/zip.ts";

const shapeOf = (names: string[]) => pbArchiveShape(names).uploadable;

Deno.test("pbArchiveShape finds uploadable directories at the archive root", () => {
  assertEquals(
    shapeOf(["pb_public/index.html", "pb_migrations/1_init.js"]),
    ["pb_migrations", "pb_public"],
  );
  assertEquals(shapeOf(["pb_public/index.html"]), ["pb_public"]);
});

Deno.test("pbArchiveShape descends into a single wrapper directory", () => {
  assertEquals(
    shapeOf(["my-app/pb_public/index.html", "my-app/README.md"]),
    ["pb_public"],
  );
});

Deno.test("pbArchiveShape accepts a hooks-only archive", () => {
  assertEquals(shapeOf(["pb_hooks/main.pb.js"]), ["pb_hooks"]);
});

Deno.test("pbArchiveShape treats a lone pb_data as the payload, not a wrapper", () => {
  assertEquals(shapeOf(["pb_data/data.db"]), []);
});

Deno.test("pbArchiveShape ignores what the platform strips from the root", () => {
  assertEquals(
    shapeOf([
      "my-app/pb_migrations/1_init.js",
      "__MACOSX/._my-app",
      ".DS_Store",
    ]),
    ["pb_migrations"],
  );
});

Deno.test("pbArchiveShape refuses a flat archive and reports what it found", () => {
  const shape = pbArchiveShape(["README.txt", "index.html"]);
  assertEquals(shape.uploadable, []);
  assertEquals(shape.found, ["README.txt", "index.html"]);
});

Deno.test("pbArchiveShape does not accept a file named like a directory", () => {
  assertEquals(shapeOf(["pb_public"]), []);
  assertEquals(shapeOf(["pb_public/"]), ["pb_public"]);
});

Deno.test("zipEntryNames reads names without inflating anything", async () => {
  const zip = await writeZip([
    { name: "pb_public/index.html", body: new TextEncoder().encode("<h1>") },
    { name: "pb_migrations/1_init.js", body: new TextEncoder().encode("//") },
  ]);
  assertEquals(zipEntryNames(zip)?.sort(), [
    "pb_migrations/1_init.js",
    "pb_public/index.html",
  ]);
});

Deno.test("zipEntryNames rejects bytes that are not a zip", () => {
  assertEquals(zipEntryNames(new TextEncoder().encode("PK-not-really")), null);
  assertEquals(zipEntryNames(new Uint8Array(0)), null);
});

Deno.test("zipEntryNames reads an entry-less archive as empty, not invalid", async () => {
  assertEquals(zipEntryNames(await writeZip([])), []);
});
