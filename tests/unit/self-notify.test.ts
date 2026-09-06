import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  CHECK_TTL_MS,
  FAIL_TTL_MS,
  notice,
  type NotifyDeps,
  notifyUpdate,
  suppressed,
} from "../../src/self/notify.ts";
import { VERSION } from "../../src/version.ts";

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
  assertEquals(suppressed(["cloud", "pb", "ls", "--json"], tty), true);
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
      env: (k) => (k === "PBC_NO_UPDATE_CHECK" ? "1" : undefined),
      isTTY: () => true,
    }),
    true,
  );
});

Deno.test("suppression reads the parse, not the raw argv", () => {
  const tty = { env: () => undefined, isTTY: () => true };
  assertEquals(suppressed(["--profile", "work", "upgrade"], tty), true);
  assertEquals(
    suppressed(["--profile", "work", "self", "upgrade", "--check"], tty),
    true,
  );
  assertEquals(
    suppressed(["--profile", "upgrade", "cloud", "pb", "ls"], tty),
    false,
  );
  assertEquals(
    suppressed(["admin", "records", "create", "posts", "--data=--json"], tty),
    false,
  );
  assertEquals(
    suppressed(
      ["admin", "records", "create", "posts", "--data", "--json"],
      tty,
    ),
    true,
  );
});

Deno.test("notice names the command that works for the install", () => {
  assertStringIncludes(notice("9.9.9", "/usr/local/bin/pb"), "pbc self upgrade");
  assertStringIncludes(
    notice("9.9.9", "/x/node_modules/@pocketbasecloud/cli-linux-x64/bin/pb"),
    "raw.githubusercontent.com/pocketbasecloud/cli",
  );
  assertStringIncludes(
    notice("9.9.9", "/x/node_modules/@pocketbasecloud/cli-linux-x64/bin/pb"),
    "deprecated",
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

  const again = harness({ fail: true, files: h.files });
  await notifyUpdate(["cloud", "pb", "ls"], again.deps);
  assertEquals(again.fetches.length, 0);
  assertEquals(again.out, []);
});

Deno.test("a corrupt cache is replaced rather than thrown over", async () => {
  const h = harness({ latest: "99.0.0" });
  await notifyUpdate(["cloud", "pb", "ls"], h.deps);
  const path = Object.keys(h.files)[0];

  const poisoned = harness({ latest: "99.0.0", files: { [path]: "{{{" } });
  await notifyUpdate(["cloud", "pb", "ls"], poisoned.deps);
  assertEquals(poisoned.fetches.length, 1);
  assertStringIncludes(poisoned.out[0], "99.0.0");
});

Deno.test("a failed check expires an hour later, not a day later", async () => {
  const failed = harness({ fail: true });
  await notifyUpdate(["cloud", "pb", "ls"], failed.deps);
  assertEquals(failed.out, []);

  const retry = harness({
    latest: "99.0.0",
    files: failed.files,
    now: 1_000_000 + FAIL_TTL_MS + 1,
  });
  await notifyUpdate(["cloud", "pb", "ls"], retry.deps);
  assertEquals(retry.fetches.length, 1);
  assertStringIncludes(retry.out[0], "99.0.0");

  const ok = harness({ latest: "99.0.0" });
  await notifyUpdate(["cloud", "pb", "ls"], ok.deps);
  const fresh = harness({
    latest: "99.0.0",
    files: ok.files,
    now: 1_000_000 + FAIL_TTL_MS + 1,
  });
  await notifyUpdate(["cloud", "pb", "ls"], fresh.deps);
  assertEquals(fresh.fetches.length, 0);
});

Deno.test("the pass before a command answers from cache and never fetches", async () => {
  const cold = harness({ latest: "99.0.0" });
  assertEquals(
    await notifyUpdate(["cloud", "logs", "--follow"], cold.deps, {
      before: true,
    }),
    "unknown",
  );
  assertEquals(cold.fetches.length, 0);
  assertEquals(cold.out, []);

  const warm = harness({ latest: "99.0.0" });
  await notifyUpdate(["cloud", "pb", "ls"], warm.deps);
  const follow = harness({ latest: "99.0.0", files: warm.files });
  assertEquals(
    await notifyUpdate(["cloud", "logs", "--follow"], follow.deps, {
      before: true,
    }),
    "announced",
  );
  assertEquals(follow.fetches.length, 0);
  assertStringIncludes(follow.out[0], "99.0.0");
});

Deno.test("a stale cache is not repeated ahead of the command", async () => {
  const h = harness({ latest: "99.0.0" });
  await notifyUpdate(["cloud", "pb", "ls"], h.deps);

  const later = harness({
    latest: "99.0.0",
    files: h.files,
    now: 1_000_000 + CHECK_TTL_MS + 1,
  });
  assertEquals(
    await notifyUpdate(["cloud", "pb", "ls"], later.deps, { before: true }),
    "unknown",
  );
  assertEquals(later.fetches.length, 0);
  assertEquals(later.out, []);
});

Deno.test("the blank line always falls between notice and command output", async () => {
  const warm = harness({ latest: "99.0.0" });
  await notifyUpdate(["cloud", "pb", "ls"], warm.deps);

  const before = harness({ latest: "99.0.0", files: warm.files });
  await notifyUpdate(["cloud", "pb", "ls"], before.deps, { before: true });
  assertEquals(before.out[0].startsWith("Update available"), true);
  assertEquals(before.out[0].endsWith("\n"), true);

  assertEquals(warm.out[0].startsWith("\nUpdate available"), true);
  assertEquals(warm.out[0].endsWith("\n"), false);
});

Deno.test("nothing to say is reported as quiet, so no second pass runs", async () => {
  const current = harness({ latest: VERSION });
  await notifyUpdate(["cloud", "pb", "ls"], current.deps);
  assertEquals(
    await notifyUpdate(
      ["cloud", "pb", "ls"],
      harness({
        latest: VERSION,
        files: current.files,
      }).deps,
      { before: true },
    ),
    "quiet",
  );
  assertEquals(
    await notifyUpdate(["cloud", "pb", "ls", "--json"], current.deps, {
      before: true,
    }),
    "quiet",
  );
});
