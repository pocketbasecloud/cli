import { assertEquals, assertRejects } from "@std/assert";
import { commitFiles } from "../../src/clients/file-commit.ts";
import {
  committableEntries,
  describeUpload,
  replacedDirs,
} from "../../src/commands/pb.ts";
import { sha256Hex } from "../../src/hash.ts";
import { CliError } from "../../src/errors.ts";
import { createMockCloudClient } from "../mocks/cloud.mock.ts";

const text = (s: string) => new TextEncoder().encode(s);
const fileOf = (name: string, body: string) => ({
  name,
  size: text(body).length,
  mtimeMs: 0,
  read: () => Promise.resolve(text(body)),
});

const ENTRIES = [
  fileOf("pb_hooks/main.pb.js", "hook"),
  fileOf("pb_public/index.html", "<h1>"),
];

function platform(
  answers: Record<string, () => Response>,
): {
  client: ReturnType<typeof createMockCloudClient>;
  posted: [string, Record<string, unknown>][];
} {
  const posted: [string, Record<string, unknown>][] = [];
  const client = createMockCloudClient({
    ext: (path, body) => {
      posted.push([path, body as Record<string, unknown>]);
      const answer = answers[path.split("/").pop()!];
      return Promise.resolve(
        answer ? answer() : Response.json({}, { status: 500 }),
      );
    },
  });
  return { client, posted };
}

function puts(): { fetchFn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = ((url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch;
  return { fetchFn, urls };
}

Deno.test("commitFiles uploads only the content the platform asks for, then commits", async () => {
  const hookHash = await sha256Hex(text("hook"));
  const { client, posted } = platform({
    upload: () =>
      Response.json({
        success: true,
        data: { uploads: [{ hash: hookHash, url: "https://r2/hook" }] },
      }),
    commit: () => Response.json({ success: true, data: { revision: 4 } }),
  });
  const { fetchFn, urls } = puts();

  const result = await commitFiles(client, {
    pocketbaseId: "pb1",
    entries: ENTRIES,
    replace: ["pb_public"],
    baseRevision: 3,
  }, fetchFn);

  assertEquals(urls, ["https://r2/hook"]);
  assertEquals(result, {
    status: "committed",
    revision: 4,
    upload: 1,
    uploadBytes: 4,
    total: 2,
  });
  const commit = posted.find(([path]) => path.endsWith("/commit"))![1];
  assertEquals(commit.baseRevision, 3);
  assertEquals(commit.replace, ["pb_public"]);
  assertEquals((commit.files as unknown[]).length, 2);
});

Deno.test("commitFiles sends the deployed commit with the commit request", async () => {
  const { client, posted } = platform({
    upload: () => Response.json({ success: true, data: { uploads: [] } }),
    commit: () => Response.json({ success: true, data: { revision: 4 } }),
  });
  const git = {
    sha: "4f2a91c0ffee",
    title: "Fix login hook",
    author: "Jane Doe",
    repo: "acme/blog",
  };

  await commitFiles(client, {
    pocketbaseId: "pb1",
    entries: ENTRIES,
    replace: [],
    git,
  });

  const commit = posted.find(([path]) => path.endsWith("/commit"))![1];
  assertEquals(commit.git, git);
});

Deno.test("commitFiles with dryRun uploads and commits nothing", async () => {
  const { client, posted } = platform({
    upload: () => Response.json({ success: true, data: { uploads: [] } }),
  });
  const { fetchFn, urls } = puts();

  const result = await commitFiles(client, {
    pocketbaseId: "pb1",
    entries: ENTRIES,
    replace: [],
    dryRun: true,
  }, fetchFn);

  assertEquals(result, {
    status: "planned",
    upload: 0,
    uploadBytes: 0,
    total: 2,
  });
  assertEquals(urls, []);
  assertEquals(posted.map(([path]) => path.split("/").pop()), ["upload"]);
});

Deno.test("commitFiles reports an older platform so the archive deploy runs instead", async () => {
  for (const status of [404, 503]) {
    const { client } = platform({
      upload: () => Response.json({ message: "no" }, { status }),
    });
    const result = await commitFiles(client, {
      pocketbaseId: "pb1",
      entries: ENTRIES,
      replace: [],
    });
    assertEquals(result, { status: "unsupported" });
  }
});

Deno.test("commitFiles turns a revision conflict into a CONFLICT error with the next step", async () => {
  const { client } = platform({
    upload: () => Response.json({ success: true, data: { uploads: [] } }),
    commit: () =>
      Response.json({
        success: false,
        message: "pb_hooks/main.pb.js changed in revision 5.",
        code: "revisionConflict",
        conflicts: [],
      }, { status: 409 }),
  });

  const error = await assertRejects(
    () =>
      commitFiles(client, {
        pocketbaseId: "pb1",
        entries: ENTRIES,
        replace: [],
        baseRevision: 3,
      }),
    CliError,
  );
  assertEquals(error.code, "CONFLICT");
  assertEquals(
    error.message.startsWith("pb_hooks/main.pb.js changed in revision 5."),
    true,
  );
  assertEquals(error.message.includes("--force"), true);
});

Deno.test("commitFiles keeps a plan refusal as the platform worded it", async () => {
  const { client } = platform({
    upload: () =>
      Response.json({
        success: false,
        message:
          "pb_public/hero.png is 2.4 MB; Free allows 1.0 MB per file. Compress it or upgrade to Starter for 100 MB.",
      }, { status: 400 }),
  });

  const error = await assertRejects(
    () =>
      commitFiles(client, {
        pocketbaseId: "pb1",
        entries: ENTRIES,
        replace: [],
      }),
    CliError,
  );
  assertEquals(error.message.includes("Free allows 1.0 MB per file"), true);
});

Deno.test("committableEntries leaves out pb_hooks files PocketBase cannot load, like the archive deploy", () => {
  const kept = committableEntries([
    ...ENTRIES,
    fileOf("pb_hooks/README", "x"),
    fileOf("pb_migrations/1_init.js", "x"),
  ]);
  assertEquals(kept.map((e) => e.name), [
    "pb_hooks/main.pb.js",
    "pb_public/index.html",
    "pb_migrations/1_init.js",
  ]);
});

Deno.test("replacedDirs replaces pb_hooks and pb_public when each ships files", () => {
  assertEquals(replacedDirs(ENTRIES), ["pb_hooks", "pb_public"]);
  assertEquals(replacedDirs([ENTRIES[0]]), ["pb_hooks"]);
  assertEquals(replacedDirs([ENTRIES[1]]), ["pb_public"]);
  assertEquals(replacedDirs([fileOf("pb_migrations/1_x.js", "m")]), []);
});

Deno.test("describeUpload names new and unchanged files", () => {
  assertEquals(
    describeUpload({ upload: 1, uploadBytes: 2048, total: 3 }),
    "1 new file(s), 2.0 KB; 2 already on the platform",
  );
  assertEquals(
    describeUpload({ upload: 0, uploadBytes: 0, total: 3 }),
    "all 3 file(s) already on the platform",
  );
});

Deno.test("commitFiles hands back the revision a failed commit recorded before failing", async () => {
  const { client } = platform({
    upload: () => Response.json({ success: true, data: { uploads: [] } }),
    commit: () =>
      Response.json({
        success: false,
        message:
          "Revision #5 did not start. The previous hooks and public files were put back as revision #6.",
        data: { revision: 6 },
      }, { status: 502 }),
  });
  const undone: number[] = [];

  await assertRejects(
    () =>
      commitFiles(client, {
        pocketbaseId: "pb1",
        entries: ENTRIES,
        replace: [],
        onUndo: (revision) => {
          undone.push(revision);
          return Promise.resolve();
        },
      }),
    CliError,
    "did not start",
  );
  assertEquals(undone, [6]);
});
