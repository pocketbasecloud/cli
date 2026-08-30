import { assertEquals, assertRejects } from "@std/assert";
import { makeLocalCommands } from "../../../src/commands/local.ts";
import { silentProgress } from "../../../src/ui/progress.ts";
import type { LocalDeps } from "../../../src/local/deps.ts";
import { detectPlatform } from "../../../src/local/platform.ts";
import { buildZip } from "../../mocks/zip.mock.ts";
import { CliError, EXIT_CODES } from "../../../src/errors.ts";
import type { CmdCtx } from "../../../src/command.ts";

const enc = new TextEncoder();
const BODY = enc.encode("#!/fake/pocketbase");

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ctx(over: Partial<CmdCtx> = {}): CmdCtx {
  return {
    args: [],
    flags: { json: false, yes: true, noInput: true, interactive: false },
    ...over,
  };
}

const RELEASES = JSON.stringify([
  { tag_name: "v0.39.9", draft: false, prerelease: false },
  { tag_name: "v0.22.50", draft: false, prerelease: false },
]);

function harness(
  opts: { zip?: Uint8Array; sums?: string; offline?: boolean } = {},
) {
  const texts = new Map<string, string>();
  const files = new Map<string, Uint8Array>();
  const out: string[] = [];
  const deps: LocalDeps = {
    fetch: ((url: string | URL | Request) => {
      if (opts.offline) throw new TypeError("offline");
      const u = String(url);
      if (u.includes("api.github.com")) {
        return Promise.resolve(new Response(RELEASES, { status: 200 }));
      }
      if (u.endsWith("checksums.txt")) {
        return Promise.resolve(new Response(opts.sums ?? "", { status: 200 }));
      }
      return Promise.resolve(
        new Response(opts.zip as BufferSource, { status: 200 }),
      );
    }) as unknown as typeof fetch,
    cwd: () => "/work",
    readTextFile: (p) => {
      const t = texts.get(p);
      return t === undefined
        ? Promise.reject(new Deno.errors.NotFound(p))
        : Promise.resolve(t);
    },
    writeFile: (p, d) => {
      files.set(p, d);
      return Promise.resolve();
    },
    writeTextFile: (p, d) => {
      texts.set(p, d);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    rename: (from, to) => {
      const d = files.get(from);
      if (d) {
        files.set(to, d);
        files.delete(from);
      }
      return Promise.resolve();
    },
    chmod: () => Promise.resolve(),
    stat: (p) =>
      Promise.resolve(files.has(p) || texts.has(p) ? { isFile: true } : null),
    remove: () => Promise.resolve(),
    env: () => undefined,
  };
  const cmds = makeLocalCommands(deps, (s) => out.push(s), silentProgress());
  return { cmds, deps, texts, files, out };
}

Deno.test("versions lists from github and marks the latest", async () => {
  const h = harness();
  assertEquals(await h.cmds["local versions"].run({}, ctx()), 0);
  const text = h.out.join("\n");
  assertEquals(text.includes("0.39.9"), true);
  assertEquals(text.includes("latest"), true);
  assertEquals(text.includes("0.22.50"), true);
});

Deno.test("versions --json reports the github source", async () => {
  const h = harness();
  await h.cmds["local versions"].run(
    {},
    ctx({ flags: { json: true, yes: true, noInput: true, interactive: false } }),
  );
  const parsed = JSON.parse(h.out[0]).data;
  assertEquals(parsed.source, "github");
  assertEquals(parsed.versions[0], "0.39.9");
  assertEquals(parsed.latest, "0.39.9");
});

Deno.test("versions falls back to the builtin list and says so", async () => {
  const h = harness({ offline: true });
  const errs: string[] = [];
  const orig = console.error;
  console.error = (s: string) => errs.push(s);
  try {
    assertEquals(await h.cmds["local versions"].run({}, ctx()), 0);
  } finally {
    console.error = orig;
  }
  assertEquals(errs.join("\n").includes("built-in"), true);
});

Deno.test("versions --json reports the builtin source when offline", async () => {
  const h = harness({ offline: true });
  await h.cmds["local versions"].run(
    {},
    ctx({ flags: { json: true, yes: true, noInput: true, interactive: false } }),
  );
  const parsed = JSON.parse(h.out[0]).data;
  assertEquals(parsed.source, "builtin");
  assertEquals(parsed.latest, null);
});

Deno.test("install downloads the latest and pins it", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const sums = `${await sha256Hex(zip)}  pocketbase_0.39.9_linux_amd64.zip`;
  const h = harness({ zip, sums });
  const code = await h.cmds["local install"].run(
    { os: "linux", arch: "amd64" },
    ctx(),
  );
  assertEquals(code, 0);
  assertEquals(h.files.get("/work/pocketbase"), BODY);
  assertEquals(
    JSON.parse(h.texts.get("/work/pbc.json")!).pocketbaseVersion,
    "0.39.9",
  );
});

Deno.test("install takes the version as a positional argument", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const sums = `${await sha256Hex(zip)}  pocketbase_0.22.50_linux_amd64.zip`;
  const h = harness({ zip, sums });
  await h.cmds["local install"].run(
    { os: "linux", arch: "amd64" },
    ctx({ args: ["0.22.50"] }),
  );
  assertEquals(
    JSON.parse(h.texts.get("/work/pbc.json")!).pocketbaseVersion,
    "0.22.50",
  );
});

Deno.test("install respects --dir", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const sums = `${await sha256Hex(zip)}  pocketbase_0.39.9_linux_amd64.zip`;
  const h = harness({ zip, sums });
  await h.cmds["local install"].run(
    { dir: "/other", os: "linux", arch: "amd64" },
    ctx(),
  );
  assertEquals(h.files.has("/other/pocketbase"), true);
});

Deno.test("init installs, scaffolds, and pins", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const sums = `${await sha256Hex(zip)}  pocketbase_0.39.9_linux_amd64.zip`;
  const h = harness({ zip, sums });
  const code = await h.cmds["local init"].run(
    { os: "linux", arch: "amd64" },
    ctx(),
  );
  assertEquals(code, 0);
  assertEquals(h.files.get("/work/pocketbase"), BODY);
  assertEquals(h.texts.has("/work/pb_hooks/main.pb.js"), true);
  assertEquals(h.texts.has("/work/.gitignore"), true);
  assertEquals(
    JSON.parse(h.texts.get("/work/pbc.json")!).pocketbaseVersion,
    "0.39.9",
  );
});

Deno.test("init --json emits the binary path and scaffold results", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const sums = `${await sha256Hex(zip)}  pocketbase_0.39.9_linux_amd64.zip`;
  const h = harness({ zip, sums });
  await h.cmds["local init"].run(
    { os: "linux", arch: "amd64" },
    ctx({ flags: { json: true, yes: true, noInput: true, interactive: false } }),
  );
  const parsed = JSON.parse(h.out[0]).data;
  assertEquals(parsed.path, "/work/pocketbase");
  assertEquals(parsed.version, "0.39.9");
  assertEquals(Array.isArray(parsed.scaffold), true);
});

Deno.test("install tells the user how to start PocketBase", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const sums = `${await sha256Hex(zip)}  pocketbase_0.39.9_linux_amd64.zip`;
  const h = harness({ zip, sums });
  await h.cmds["local install"].run({ os: "linux", arch: "amd64" }, ctx());
  assertEquals(h.out.join("\n").includes("./pocketbase serve"), true);
});

Deno.test("the start hint cds into --dir when it is not the working directory", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const sums = `${await sha256Hex(zip)}  pocketbase_0.39.9_linux_amd64.zip`;
  const h = harness({ zip, sums });
  await h.cmds["local install"].run(
    { dir: "/other", os: "linux", arch: "amd64" },
    ctx(),
  );
  assertEquals(
    h.out.join("\n").includes("cd /other && ./pocketbase serve"),
    true,
  );
});

Deno.test("init tells the user how to start PocketBase", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const sums = `${await sha256Hex(zip)}  pocketbase_0.39.9_linux_amd64.zip`;
  const h = harness({ zip, sums });
  await h.cmds["local init"].run({ os: "linux", arch: "amd64" }, ctx());
  assertEquals(h.out.join("\n").includes("./pocketbase serve"), true);
});

Deno.test("the start hint still shows when the binary was already present", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const sums = `${await sha256Hex(zip)}  pocketbase_0.39.9_linux_amd64.zip`;
  const h = harness({ zip, sums });
  await h.cmds["local install"].run({ os: "linux", arch: "amd64" }, ctx());
  h.out.length = 0;
  await h.cmds["local install"].run({ os: "linux", arch: "amd64" }, ctx());
  const text = h.out.join("\n");
  assertEquals(text.includes("already exists"), true);
  assertEquals(text.includes("./pocketbase serve"), true);
});

Deno.test("--json output carries no prose hint", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const sums = `${await sha256Hex(zip)}  pocketbase_0.39.9_linux_amd64.zip`;
  const h = harness({ zip, sums });
  await h.cmds["local install"].run(
    { os: "linux", arch: "amd64" },
    ctx({ flags: { json: true, yes: true, noInput: true, interactive: false } }),
  );
  assertEquals(h.out.length, 1);
  assertEquals(JSON.parse(h.out[0]).data.version, "0.39.9");
});

const HOST = detectPlatform();
const HOST_BIN = `/work/${HOST.binName}`;

Deno.test("which reports the binary and its pin", async () => {
  const zip = await buildZip([{ name: HOST.binName, body: BODY }]);
  const sums = `${await sha256Hex(zip)}  ${HOST.assetName("0.39.9")}`;
  const h = harness({ zip, sums });
  await h.cmds["local install"].run({ os: HOST.os, arch: HOST.arch }, ctx());
  h.out.length = 0;
  assertEquals(await h.cmds["local which"].run({}, ctx()), 0);
  const text = h.out.join("\n");
  assertEquals(text.includes(HOST_BIN), true);
  assertEquals(text.includes("0.39.9"), true);
});

Deno.test("which exits with a platform error when nothing is installed", async () => {
  const h = harness();
  const e = await assertRejects(() => h.cmds["local which"].run({}, ctx()), CliError);
  assertEquals((e as CliError).exitCode, EXIT_CODES.PLATFORM);
  assertEquals((e as Error).message.includes("pbc local init"), true);
});

Deno.test("which reports unknown when the binary has no pin", async () => {
  const h = harness();
  h.files.set(HOST_BIN, BODY);
  assertEquals(await h.cmds["local which"].run({}, ctx()), 0);
  assertEquals(h.out.join("\n").includes("unknown"), true);
});
