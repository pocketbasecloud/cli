import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  applyUpgrade,
  detectInstall,
  manualCommand,
  planUpgrade,
  replaceBinary,
  type SelfDeps,
} from "../../../src/self/upgrade.ts";
import { VERSION } from "../../../src/version.ts";
import { CliError } from "../../../src/errors.ts";
import { sha256Hex } from "../../../src/hash.ts";
import { buildTarGz } from "../../mocks/tar.mock.ts";
import { buildZip } from "../../mocks/zip.mock.ts";

const enc = new TextEncoder();
const BODY = enc.encode("#!/fake/pb binary\n");

function newer(): string {
  const [maj, min, patch] = VERSION.split("-")[0].split(".").map(Number);
  return `${maj}.${min}.${patch + 1}`;
}
const OLDER = "0.0.1";

Deno.test("detectInstall recognises a standalone binary", () => {
  assertEquals(detectInstall("/usr/local/bin/pb"), {
    kind: "standalone",
    path: "/usr/local/bin/pb",
  });
  assertEquals(detectInstall("/home/t/.local/bin/pb").kind, "standalone");
});

Deno.test("detectInstall recognises an npm install by its node_modules path", () => {
  const p =
    "/usr/lib/node_modules/@pocketbasecloud/cli/node_modules/@pocketbasecloud/cli-linux-x64/bin/pb";
  assertEquals(detectInstall(p).kind, "npm");
});

Deno.test("detectInstall recognises an npx run", () => {
  const p =
    "/home/t/.npm/_npx/abc123/node_modules/@pocketbasecloud/cli-linux-x64/bin/pb";
  assertEquals(detectInstall(p).kind, "npm");
});

Deno.test("detectInstall recognises a Windows npm install", () => {
  const p =
    "C:\\Users\\t\\AppData\\Roaming\\npm\\node_modules\\@pocketbasecloud\\cli-win32-x64\\bin\\pb.exe";
  assertEquals(detectInstall(p).kind, "npm");
});

Deno.test("detectInstall recognises running from source as Deno", () => {
  assertEquals(detectInstall("/home/t/.deno/bin/deno").kind, "source");
  assertEquals(
    detectInstall("C:\\Program Files\\deno\\deno.exe").kind,
    "source",
  );
});

Deno.test("detectInstall treats a Windows standalone binary as standalone", () => {
  assertEquals(detectInstall("C:\\tools\\pb.exe").kind, "standalone");
});

Deno.test("manualCommand names the tool that owns the install", () => {
  assertStringIncludes(manualCommand("npm"), "npm i -g @pocketbasecloud/cli");
  assertStringIncludes(manualCommand("source"), "deno install");
});

type Harness = {
  deps: SelfDeps;
  files: Map<string, Uint8Array>;
  ops: string[];
  urls: string[];
};

function harness(opts: {
  release?: string;
  execPath?: string;
  host?: string;
  archive?: Uint8Array;
  digest?: string;
  manifestStatus?: number;
  assetStatus?: number;
  failWrite?: Error;
  failRename?: Error;
  failRemove?: boolean;
} = {}): Harness {
  const release = opts.release ?? newer();
  const host = opts.host ?? "linux-x64";
  const files = new Map<string, Uint8Array>();
  const ops: string[] = [];
  const urls: string[] = [];

  const deps: SelfDeps = {
    fetch: (async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith("checksums.txt")) {
        if (opts.manifestStatus && opts.manifestStatus !== 200) {
          return new Response("nope", { status: opts.manifestStatus });
        }
        const digest = opts.digest ??
          (opts.archive ? await sha256Hex(opts.archive) : "0".repeat(64));
        const lines = [
          `${digest}  pb_${release}_linux_x64.tar.gz`,
          `${digest}  pb_${release}_linux_arm64.tar.gz`,
          `${digest}  pb_${release}_darwin_x64.tar.gz`,
          `${digest}  pb_${release}_darwin_arm64.tar.gz`,
          `${digest}  pb_${release}_win32_x64.zip`,
        ];
        return new Response(lines.join("\n") + "\n", { status: 200 });
      }
      if (opts.assetStatus && opts.assetStatus !== 200) {
        return new Response("nf", { status: opts.assetStatus });
      }
      return new Response(opts.archive as BufferSource, { status: 200 });
    }) as unknown as typeof fetch,
    cwd: () => "/work",
    readTextFile: () => Promise.reject(new Deno.errors.NotFound("x")),
    writeFile: (p, d) => {
      if (opts.failWrite) return Promise.reject(opts.failWrite);
      ops.push(`write:${p}`);
      files.set(p, d);
      return Promise.resolve();
    },
    writeTextFile: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    rename: (from, to) => {
      if (opts.failRename) return Promise.reject(opts.failRename);
      ops.push(`rename:${from}->${to}`);
      const d = files.get(from);
      if (d) {
        files.set(to, d);
        files.delete(from);
      }
      return Promise.resolve();
    },
    chmod: (p, mode) => {
      ops.push(`chmod:${p}:${mode.toString(8)}`);
      return Promise.resolve();
    },
    stat: (p) => Promise.resolve(files.has(p) ? { isFile: true } : null),
    remove: (p) => {
      if (opts.failRemove) return Promise.reject(new Error("locked"));
      ops.push(`remove:${p}`);
      files.delete(p);
      return Promise.resolve();
    },
    env: () => undefined,
    execPath: () => opts.execPath ?? "/usr/local/bin/pb",
    hostKey: () => host,
  };
  return { deps, files, ops, urls };
}

Deno.test("planUpgrade reports up-to-date when the release matches", async () => {
  const { plan } = await planUpgrade(harness({ release: VERSION }).deps);
  assertEquals(plan.action, "up-to-date");
  assertEquals(plan.updateAvailable, false);
  assertEquals(plan.current, VERSION);
  assertEquals(plan.target, VERSION);
});

Deno.test("planUpgrade plans an upgrade for a standalone install", async () => {
  const { plan } = await planUpgrade(harness().deps);
  assertEquals(plan.action, "upgrade");
  assertEquals(plan.updateAvailable, true);
  assertEquals(plan.target, newer());
  assertEquals(plan.command, undefined);
});

Deno.test("planUpgrade defers to npm for an npm install", async () => {
  const { plan } = await planUpgrade(
    harness({
      execPath: "/x/node_modules/@pocketbasecloud/cli-linux-x64/bin/pb",
    })
      .deps,
  );
  assertEquals(plan.action, "manual");
  assertEquals(plan.command, "npm i -g @pocketbasecloud/cli@latest");
});

Deno.test("planUpgrade defers to the clone for a source install", async () => {
  const { plan } = await planUpgrade(harness({ execPath: "/bin/deno" }).deps);
  assertEquals(plan.action, "manual");
  assertStringIncludes(plan.command ?? "", "deno install");
});

Deno.test("planUpgrade uses the latest redirect when no version is requested", async () => {
  const h = harness();
  await planUpgrade(h.deps);
  assertStringIncludes(h.urls[0], "/releases/latest/download/checksums.txt");
});

Deno.test("planUpgrade requests the tagged manifest for an explicit version", async () => {
  const h = harness({ release: OLDER });
  await planUpgrade(h.deps, { version: OLDER });
  assertStringIncludes(h.urls[0], `/releases/download/v${OLDER}/checksums.txt`);
});

Deno.test("planUpgrade treats an explicit older version as a deliberate downgrade", async () => {
  const { plan } = await planUpgrade(harness({ release: OLDER }).deps, {
    version: OLDER,
  });
  assertEquals(plan.action, "upgrade");
  assertEquals(plan.target, OLDER);
  assertEquals(plan.updateAvailable, false);
});

Deno.test("planUpgrade accepts a v-prefixed version", async () => {
  const h = harness({ release: OLDER });
  await planUpgrade(h.deps, { version: `v${OLDER}` });
  assertStringIncludes(h.urls[0], `/releases/download/v${OLDER}/checksums.txt`);
});

Deno.test("planUpgrade re-installs the current version under --force", async () => {
  const { plan } = await planUpgrade(harness({ release: VERSION }).deps, {
    force: true,
  });
  assertEquals(plan.action, "upgrade");
  assertEquals(plan.updateAvailable, false);
});

Deno.test("planUpgrade still defers under --force when npm owns the install", async () => {
  const { plan } = await planUpgrade(
    harness({
      release: VERSION,
      execPath: "/x/node_modules/@pocketbasecloud/cli-linux-x64/bin/pb",
    }).deps,
    { force: true },
  );
  assertEquals(plan.action, "manual");
});

Deno.test("replaceBinary writes a temp file, chmods it, then renames into place", async () => {
  const h = harness();
  const res = await replaceBinary(h.deps, "/usr/local/bin/pb", BODY, false);
  assertEquals(res.leftBehind, undefined);
  assertEquals(h.files.get("/usr/local/bin/pb"), BODY);

  const tmp = h.ops[0].slice("write:".length);
  assertStringIncludes(tmp, "/usr/local/bin/.pbc.upgrade.");
  assertEquals(h.ops[1], `chmod:${tmp}:755`);
  assertEquals(h.ops[2], `rename:${tmp}->/usr/local/bin/pb`);
});

Deno.test("replaceBinary moves the old image aside on Windows", async () => {
  const h = harness({ host: "win32-x64" });
  h.files.set("/tools/pb.exe", enc.encode("old"));
  const res = await replaceBinary(h.deps, "/tools/pb.exe", BODY, true);

  assertEquals(h.files.get("/tools/pb.exe"), BODY);
  assertEquals(res.leftBehind, undefined);
  assertEquals(
    h.ops.some((o) => o === "rename:/tools/pb.exe->/tools/pb.exe.old"),
    true,
  );
});

Deno.test("replaceBinary reports the old image when Windows keeps it locked", async () => {
  const h = harness({ host: "win32-x64", failRemove: true });
  h.files.set("/tools/pb.exe", enc.encode("old"));
  const res = await replaceBinary(h.deps, "/tools/pb.exe", BODY, true);
  assertEquals(res.leftBehind, "/tools/pb.exe.old");
  assertEquals(h.files.get("/tools/pb.exe"), BODY);
});

Deno.test("replaceBinary explains an unwritable install directory", async () => {
  const h = harness({ failWrite: new Deno.errors.PermissionDenied("denied") });
  const e = await assertRejects(
    () => replaceBinary(h.deps, "/usr/local/bin/pb", BODY, false),
    CliError,
    "No permission to write to /usr/local/bin",
  );
  assertStringIncludes(e.message, "sudo pbc self upgrade");
});

Deno.test("replaceBinary cleans up the temp file when the rename fails", async () => {
  const h = harness({
    failRename: new Deno.errors.PermissionDenied("operation not permitted"),
  });
  await assertRejects(
    () => replaceBinary(h.deps, "/usr/local/bin/pb", BODY, false),
    CliError,
    "No permission to replace /usr/local/bin/pb",
  );
  assertEquals(h.files.size, 0);
  assertEquals(h.ops.some((o) => o.startsWith("remove:")), true);
});

Deno.test("replaceBinary rethrows a non-permission failure unchanged", async () => {
  const h = harness({ failRename: new Error("disk full") });
  await assertRejects(
    () => replaceBinary(h.deps, "/usr/local/bin/pb", BODY, false),
    Error,
    "disk full",
  );
});

Deno.test("applyUpgrade downloads, verifies, extracts, and installs a tar.gz", async () => {
  const archive = await buildTarGz([{ name: "pb", body: BODY }]);
  const h = harness({ archive });
  const { plan, manifest } = await planUpgrade(h.deps);
  const res = await applyUpgrade(h.deps, plan, manifest);

  assertEquals(res.path, "/usr/local/bin/pb");
  assertEquals(h.files.get("/usr/local/bin/pb"), BODY);
  assertStringIncludes(
    h.urls[1],
    `/releases/download/v${newer()}/pb_${newer()}_linux_x64.tar.gz`,
  );
});

Deno.test("applyUpgrade extracts pb.exe from the Windows zip", async () => {
  const archive = await buildZip([{ name: "pb.exe", body: BODY }]);
  const h = harness({
    archive,
    host: "win32-x64",
    execPath: "C:/tools/pb.exe",
  });
  const { plan, manifest } = await planUpgrade(h.deps);
  const res = await applyUpgrade(h.deps, plan, manifest);

  assertEquals(h.files.get("C:/tools/pb.exe"), BODY);
  assertEquals(res.path, "C:/tools/pb.exe");
  assertStringIncludes(h.urls[1], `pb_${newer()}_win32_x64.zip`);
});

Deno.test("applyUpgrade refuses a mismatched checksum and writes nothing", async () => {
  const archive = await buildTarGz([{ name: "pb", body: BODY }]);
  const h = harness({ archive, digest: "f".repeat(64) });
  const { plan, manifest } = await planUpgrade(h.deps);

  await assertRejects(
    () => applyUpgrade(h.deps, plan, manifest),
    CliError,
    "Checksum mismatch",
  );
  assertEquals(h.files.size, 0);
  assertEquals(h.ops.length, 0);
});

Deno.test("applyUpgrade refuses when the release lists no digest for this asset", async () => {
  const archive = await buildTarGz([{ name: "pb", body: BODY }]);
  const h = harness({ archive });
  const { plan, manifest } = await planUpgrade(h.deps);
  delete manifest.checksums[`pb_${newer()}_linux_x64.tar.gz`];

  await assertRejects(
    () => applyUpgrade(h.deps, plan, manifest),
    CliError,
    "lists no checksum",
  );
  assertEquals(h.files.size, 0);
});

Deno.test("applyUpgrade surfaces a failed asset download", async () => {
  const h = harness({ assetStatus: 404 });
  const { plan, manifest } = await planUpgrade(h.deps);
  await assertRejects(
    () => applyUpgrade(h.deps, plan, manifest),
    CliError,
    "Download failed (404)",
  );
});

Deno.test("applyUpgrade fails when the archive lacks the binary", async () => {
  const archive = await buildTarGz([{ name: "NOTES", body: BODY }]);
  const h = harness({ archive });
  const { plan, manifest } = await planUpgrade(h.deps);
  await assertRejects(
    () => applyUpgrade(h.deps, plan, manifest),
    CliError,
    '"pb" not found',
  );
  assertEquals(h.files.size, 0);
});
