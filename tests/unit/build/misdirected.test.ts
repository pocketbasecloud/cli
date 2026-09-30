import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { misdirectedDeploy } from "../../../src/build/misdirected.ts";
import { writeZip } from "../../../src/build/zip.ts";

function dir(files: Record<string, string> = {}): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

async function zipOf(files: Record<string, string>): Promise<string> {
  const enc = new TextEncoder();
  const zipPath = join(Deno.makeTempDirSync(), "upload.zip");
  await Deno.writeFile(
    zipPath,
    await writeZip(
      Object.entries(files).map(([name, body]) => ({
        name,
        body: enc.encode(body),
      })),
    ),
  );
  return zipPath;
}

const POCKETBASE_APP = {
  "pb_hooks/main.pb.js": "//",
  "pb_migrations/1_init.js": "//",
  "pb_public/index.html": "<p>",
};

const nested = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([path, body]) => [`App/my-app/${path}`, body]),
  );

Deno.test("a PocketBase directory deployed as a backend is sent to PocketBase", async () => {
  const message = await misdirectedDeploy("backends", {
    cwd: dir(POCKETBASE_APP),
  });
  assertStringIncludes(message ?? "", "This is PocketBase source");
  assertStringIncludes(message ?? "", "pbc pocketbase deploy");
});

Deno.test("an explicit runtime is never second-guessed", async () => {
  assertEquals(
    await misdirectedDeploy("backends", {
      cwd: dir(POCKETBASE_APP),
      runtime: "deno",
    }),
    null,
  );
});

Deno.test("a recorded runtime in pbc.json is never second-guessed", async () => {
  assertEquals(
    await misdirectedDeploy("backends", {
      cwd: dir({
        ...POCKETBASE_APP,
        "pbc.json": JSON.stringify({ build: { runtime: "deno" } }),
      }),
    }),
    null,
  );
});

Deno.test("a static site deployed as a backend is sent to a frontend", async () => {
  const message = await misdirectedDeploy("backends", {
    cwd: dir({ "index.html": "<p>" }),
  });
  assertStringIncludes(message ?? "", "pbc frontend deploy");
});

Deno.test("a deno backend deployed as a frontend is sent to a backend", async () => {
  const message = await misdirectedDeploy("frontends", {
    cwd: dir({ "deno.json": "{}", "main.ts": "" }),
  });
  assertStringIncludes(message ?? "", "pbc backend deploy");
});

Deno.test("a PocketBase directory deployed as a frontend is sent to PocketBase", async () => {
  const message = await misdirectedDeploy("frontends", {
    cwd: dir(POCKETBASE_APP),
  });
  assertStringIncludes(message ?? "", "pbc pocketbase deploy");
});

Deno.test("a frontend with its own index.html deploys as a frontend", async () => {
  assertEquals(
    await misdirectedDeploy("frontends", {
      cwd: dir({ "index.html": "<p>", "deno.json": "{}" }),
    }),
    null,
  );
});

Deno.test("a prebuilt site in a recorded output directory deploys as a frontend", async () => {
  assertEquals(
    await misdirectedDeploy("frontends", {
      cwd: dir({
        "deno.json": "{}",
        "_site/index.html": "<p>",
        "pbc.json": JSON.stringify({ build: { outputDir: "_site" } }),
      }),
    }),
    null,
  );
});

Deno.test("a PocketBase instance can still be created bare from a backend's directory", async () => {
  assertEquals(
    await misdirectedDeploy("pocketbases", {
      cwd: dir({ "deno.json": "{}", "main.ts": "" }),
    }),
    null,
  );
});

Deno.test("a directory with nothing recognisable is left to the deploy", async () => {
  assertEquals(
    await misdirectedDeploy("pocketbases", { cwd: dir({ "notes.txt": "" }) }),
    null,
  );
});

Deno.test("a nested PocketBase zip deployed as a backend is sent to PocketBase", async () => {
  const zipPath = await zipOf(nested(POCKETBASE_APP));
  const message = await misdirectedDeploy("backends", { cwd: dir(), zipPath });
  assertStringIncludes(message ?? "", "pb_hooks/, pb_migrations/, pb_public/");
  assertStringIncludes(message ?? "", `pbc pocketbase deploy --zip ${zipPath}`);
});

Deno.test("a nested PocketBase zip deploys as PocketBase", async () => {
  const zipPath = await zipOf(nested(POCKETBASE_APP));
  assertEquals(
    await misdirectedDeploy("pocketbases", { cwd: dir(), zipPath }),
    null,
  );
});

Deno.test("a python zip deployed as PocketBase is sent to a backend", async () => {
  const zipPath = await zipOf(nested({ "requirements.txt": "", "app.py": "" }));
  const message = await misdirectedDeploy("pocketbases", {
    cwd: dir(),
    zipPath,
  });
  assertStringIncludes(message ?? "", "requirements.txt");
  assertStringIncludes(message ?? "", "pbc backend deploy --zip");
});

Deno.test("the suggested command quotes a zip path a shell would split", async () => {
  const zipPath = await zipOf(POCKETBASE_APP);
  const spaced = join(Deno.makeTempDirSync(), "Tom's App.zip");
  await Deno.rename(zipPath, spaced);
  const message = await misdirectedDeploy("backends", {
    cwd: dir(),
    zipPath: spaced,
  });
  assertStringIncludes(
    message ?? "",
    `--zip '${spaced.replace("Tom's", "Tom'\\''s")}'`,
  );
});

Deno.test("OS metadata inside a zip does not hide what it is", async () => {
  const zipPath = await zipOf({
    "App/.DS_Store": "junk",
    "App/api/Thumbs.db": "junk",
    "App/api/deno.json": "{}",
    "App/api/main.ts": "",
  });
  const message = await misdirectedDeploy("pocketbases", { cwd: dir(), zipPath });
  assertStringIncludes(message ?? "", "deno.json");
});
