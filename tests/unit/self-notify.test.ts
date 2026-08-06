import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  CHECK_TTL_MS,
  notice,
  type NotifyDeps,
  notifyUpdate,
  suppressed,
} from "../../src/self/notify.ts";
import { VERSION } from "../../src/version.ts";

/** A checksums.txt naming one release, which is how the version is resolved. */
function checksums(version: string): string {
  return `abc123  pb_${version}_linux_x64.tar.gz\n`;
}

type Harness = {
  deps: NotifyDeps;
  out: string[];
  files: Record<string, string>;
  fetches: string[];
};

function harness(o: {
  latest?: string;
  files?: Record<string, string>;
  env?: Record<string, string>;
  isTTY?: boolean;
  now?: number;
  fail?: boolean;
} = {}): Harness {
  const out: string[] = [];
  const files: Record<string, string> = { ...o.files };
  const fetches: string[] = [];
  const deps: NotifyDeps = {
    fetch: (input) => {
      fetches.push(String(input));
      if (o.fail) return Promise.reject(new Error("offline"));
      return Promise.resolve(
        new Response(checksums(o.latest ?? VERSION), { status: 200 }),
      );
    },
    env: (k) => o.env?.[k],
    now: () => o.now ?? 1_000_000,
    readTextFile: (p) =>
      p in files
        ? Promise.resolve(files[p])
        : Promise.reject(new Error("not found")),
    writeTextFile: (p, d) => {
      files[p] = d;
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    write: (s) => out.push(s),
    isTTY: () => o.isTTY ?? true,
    execPath: () => "/usr/local/bin/pb",
  };
  return { deps, out, files, fetches };
}

Deno.test("suppressed keeps quiet where a notice would be noise", () => {
  const tty = { env: () => undefined, isTTY: () => true };
  assertEquals(suppressed(["cloud", "pb", "ls"], tty), false);
  // --json is parsed by something; an extra line would corrupt it.
  assertEquals(suppressed(["cloud", "pb", "ls", "--json"], tty), true);
  // `pb upgrade` prints both versions itself.
  assertEquals(suppressed(["upgrade", "--check"], tty), true);
  assertEquals(
    suppressed(["cloud", "pb", "ls"], {
      env: () => undefined,
      isTTY: () => false,
    }),
    true,
  );
  assertEquals(
    suppressed(["cloud", "pb", "ls"], {
      env: (k) => (k === "CI" ? "1" : undefined),
      isTTY: () => true,
    }),
    true,
  );
  assertEquals(
    suppressed(["cloud", "pb", "ls"], {
      env: (k) => (k === "PB_NO_UPDATE_CHECK" ? "1" : undefined),
      isTTY: () => true,
    }),
    true,
  );
});

Deno.test("notice names the command that works for the install", () => {
  assertStringIncludes(notice("9.9.9", "/usr/local/bin/pb"), "pb upgrade");
  assertStringIncludes(
    notice("9.9.9", "/x/node_modules/@pocketbasecloud/cli-linux-x64/bin/pb"),
    "npm i -g @pocketbasecloud/cli@latest",
  );
  assertStringIncludes(notice("9.9.9", "/usr/local/bin/pb"), VERSION);
  assertStringIncludes(notice("9.9.9", "/usr/local/bin/pb"), "9.9.9");
});

Deno.test("a newer release is announced and cached", async () => {
  const h = harness({ latest: "99.0.0" });
  await notifyUpdate(["cloud", "pb", "ls"], h.deps);
  assertEquals(h.out.length, 1);
  assertStringIncludes(h.out[0], "Update available");
  assertStringIncludes(h.out[0], "99.0.0");
  assertEquals(h.fetches.length, 1);
  // The lookup is remembered, so the next command costs nothing.
  const written = Object.values(h.files);
  assertEquals(written.length, 1);
  assertEquals(JSON.parse(written[0]).latest, "99.0.0");
});

Deno.test("the current version says nothing", async () => {
  const h = harness({ latest: VERSION });
  await notifyUpdate(["cloud", "pb", "ls"], h.deps);
  assertEquals(h.out, []);
});

Deno.test("a fresh cache is trusted without a request", async () => {
  const h = harness({ latest: "99.0.0" });
  await notifyUpdate(["cloud", "pb", "ls"], h.deps);
  assertEquals(h.fetches.length, 1);

  // A second run over the same cache: same notice, no second request.
  const again = harness({ latest: "99.0.0", files: h.files });
  await notifyUpdate(["cloud", "pb", "ls"], again.deps);
  assertEquals(again.fetches.length, 0);
  assertStringIncludes(again.out[0], "99.0.0");
});

Deno.test("a stale cache is refreshed", async () => {
  const h = harness({ latest: "99.0.0" });
  await notifyUpdate(["cloud", "pb", "ls"], h.deps);

  const later = harness({
    latest: "99.0.0",
    files: h.files,
    now: 1_000_000 + CHECK_TTL_MS + 1,
  });
  await notifyUpdate(["cloud", "pb", "ls"], later.deps);
  assertEquals(later.fetches.length, 1);
});

Deno.test("an unreachable GitHub is silent and not retried immediately", async () => {
  const h = harness({ fail: true });
  await notifyUpdate(["cloud", "pb", "ls"], h.deps);
  assertEquals(h.out, []);
  assertEquals(h.fetches.length, 1);

  // The failed attempt is recorded, so the next command does not try again.
  const again = harness({ fail: true, files: h.files });
  await notifyUpdate(["cloud", "pb", "ls"], again.deps);
  assertEquals(again.fetches.length, 0);
  assertEquals(again.out, []);
});

Deno.test("a corrupt cache is replaced rather than thrown over", async () => {
  const h = harness({ latest: "99.0.0" });
  // Whatever path the module writes to, poison it.
  await notifyUpdate(["cloud", "pb", "ls"], h.deps);
  const path = Object.keys(h.files)[0];

  const poisoned = harness({ latest: "99.0.0", files: { [path]: "{{{" } });
  await notifyUpdate(["cloud", "pb", "ls"], poisoned.deps);
  assertEquals(poisoned.fetches.length, 1);
  assertStringIncludes(poisoned.out[0], "99.0.0");
});
