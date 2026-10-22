import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { HashIndex } from "../../src/hash-index.ts";
import { sha256Hex } from "../../src/hash.ts";

const text = (s: string) => new TextEncoder().encode(s);

function file(name: string, body: string, mtimeMs: number) {
  const reads: string[] = [];
  return {
    reads,
    entry: {
      name,
      size: text(body).length,
      mtimeMs,
      read: () => {
        reads.push(name);
        return Promise.resolve(text(body));
      },
    },
  };
}

Deno.test("an unchanged file is hashed once and then served from the saved index", async () => {
  const home = await Deno.makeTempDir();
  const env = { HOME: home };
  const first = await HashIndex.load("/work/app", env, () => 100_000);
  const a = file("pb_public/a.html", "<h1>", 10_000);
  assertEquals(await first.hashOf(a.entry), await sha256Hex(text("<h1>")));
  await first.save();

  const second = await HashIndex.load("/work/app", env, () => 200_000);
  const again = file("pb_public/a.html", "<h1>", 10_000);
  assertEquals(await second.hashOf(again.entry), await sha256Hex(text("<h1>")));
  assertEquals(again.reads, []);
  const saved = [...Deno.readDirSync(join(home, ".config", "pbc", "hashes"))];
  assertEquals(saved.length, 1);
});

Deno.test("a changed size or mtime, or a file written just before hashing, is read again", async () => {
  const home = await Deno.makeTempDir();
  const env = { HOME: home };
  const index = await HashIndex.load("/work/app", env, () => 100_000);
  await index.hashOf(file("a", "one", 10_000).entry);
  await index.hashOf(file("racy", "two", 99_500).entry);
  await index.save();

  const next = await HashIndex.load("/work/app", env, () => 200_000);
  const resized = file("a", "three", 10_000);
  const touched = file("a", "one", 20_000);
  const racy = file("racy", "two", 99_500);
  await next.hashOf(resized.entry);
  await next.hashOf(touched.entry);
  await next.hashOf(racy.entry);
  assertEquals([resized.reads, touched.reads, racy.reads], [["a"], ["a"], [
    "racy",
  ]]);
});

Deno.test("each project directory has its own index and files gone from it are dropped", async () => {
  const home = await Deno.makeTempDir();
  const env = { HOME: home };
  const app = await HashIndex.load("/work/app", env, () => 100_000);
  await app.hashOf(file("a", "x", 10).entry);
  await app.hashOf(file("b", "y", 10).entry);
  await app.save();

  const other = await HashIndex.load("/work/other", env, () => 200_000);
  const fromOther = file("a", "x", 10);
  await other.hashOf(fromOther.entry);
  assertEquals(fromOther.reads, ["a"]);

  const later = await HashIndex.load("/work/app", env, () => 200_000);
  await later.hashOf(file("a", "x", 10).entry);
  await later.save();
  const reread = await HashIndex.load("/work/app", env, () => 300_000);
  const gone = file("b", "y", 10);
  await reread.hashOf(gone.entry);
  assertEquals(gone.reads, ["b"]);
});
