import { assertEquals, assertRejects } from "@std/assert";
import {
  installBinary,
  pinVersion,
  readPin,
} from "../../../src/local/install.ts";
import type { LocalDeps } from "../../../src/local/deps.ts";
import { buildZip } from "../../mocks/zip.mock.ts";
import { CliError } from "../../../src/errors.ts";

const enc = new TextEncoder();
const BODY = enc.encode("#!/fake/pocketbase binary");

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Harness = {
  deps: LocalDeps;
  files: Map<string, Uint8Array>;
  texts: Map<string, string>;
  ops: string[];
};

function harness(opts: {
  zip?: Uint8Array;
  checksums?: string | null;
  existing?: string[];
} = {}): Harness {
  const files = new Map<string, Uint8Array>();
  const texts = new Map<string, string>();
  const ops: string[] = [];
  const existing = new Set(opts.existing ?? []);

  const deps: LocalDeps = {
    fetch: ((url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("checksums.txt")) {
        if (opts.checksums === null) {
          return Promise.resolve(new Response("nope", { status: 404 }));
        }
        return Promise.resolve(
          new Response(opts.checksums ?? "", { status: 200 }),
        );
      }
      if (!opts.zip) {
        return Promise.resolve(new Response("nf", { status: 404 }));
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
      ops.push(`write:${p}`);
      files.set(p, d);
      return Promise.resolve();
    },
    writeTextFile: (p, d) => {
      ops.push(`writeText:${p}`);
      texts.set(p, d);
      return Promise.resolve();
    },
    mkdir: (p) => {
      ops.push(`mkdir:${p}`);
      return Promise.resolve();
    },
    rename: (from, to) => {
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
    stat: (p) =>
      Promise.resolve(
        existing.has(p) || files.has(p) || texts.has(p)
          ? { isFile: true }
          : null,
      ),
    remove: (p) => {
      ops.push(`remove:${p}`);
      files.delete(p);
      return Promise.resolve();
    },
    env: () => undefined,
  };
  return { deps, files, texts, ops };
}

const ASSET = "pocketbase_0.39.9_linux_amd64.zip";

Deno.test("installBinary downloads, extracts, chmods, and renames into place", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const h = harness({ zip, checksums: `${await sha256Hex(zip)}  ${ASSET}` });

  const res = await installBinary(h.deps, {
    version: "0.39.9",
    dir: "/work",
    os: "linux",
    arch: "amd64",
  });

  assertEquals(res.version, "0.39.9");
  assertEquals(res.path, "/work/pocketbase");
  assertEquals(res.skipped, false);
  assertEquals(res.checksumVerified, true);
  assertEquals(h.files.get("/work/pocketbase"), BODY);

  // Written to a temp path, chmodded, then renamed — never a partial binary
  // sitting at the final path.
  const write = h.ops.findIndex((o) => o.startsWith("write:/work/.pocketbase"));
  const chmod = h.ops.findIndex((o) => o.startsWith("chmod:"));
  const rename = h.ops.findIndex((o) => o.startsWith("rename:"));
  assertEquals(write >= 0 && chmod > write && rename > chmod, true);
});

Deno.test("installBinary accepts a v-prefixed version", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const h = harness({ zip, checksums: `${await sha256Hex(zip)}  ${ASSET}` });
  const res = await installBinary(h.deps, {
    version: "v0.39.9",
    dir: "/work",
    os: "linux",
    arch: "amd64",
  });
  assertEquals(res.version, "0.39.9");
});

Deno.test("installBinary aborts on a checksum mismatch without writing", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const h = harness({ zip, checksums: `${"0".repeat(64)}  ${ASSET}` });
  const e = await assertRejects(
    () =>
      installBinary(h.deps, {
        version: "0.39.9",
        dir: "/work",
        os: "linux",
        arch: "amd64",
      }),
    CliError,
  );
  assertEquals((e as Error).message.includes("Checksum"), true);
  assertEquals(h.files.size, 0);
  assertEquals(h.ops.some((o) => o.startsWith("rename:")), false);
});

Deno.test("installBinary continues when checksums.txt is missing", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const h = harness({ zip, checksums: null });
  const res = await installBinary(h.deps, {
    version: "0.39.9",
    dir: "/work",
    os: "linux",
    arch: "amd64",
  });
  assertEquals(res.checksumVerified, false);
  assertEquals(h.files.get("/work/pocketbase"), BODY);
});

Deno.test("installBinary reports a 404 as an unknown version", async () => {
  const h = harness({});
  const e = await assertRejects(
    () =>
      installBinary(h.deps, {
        version: "9.9.9",
        dir: "/work",
        os: "linux",
        arch: "amd64",
      }),
    CliError,
  );
  assertEquals((e as CliError).exitCode, 2);
  assertEquals((e as Error).message.includes("pbc versions"), true);
});

Deno.test("installBinary skips an existing binary without --force", async () => {
  const h = harness({ existing: ["/work/pocketbase"] });
  const res = await installBinary(h.deps, {
    version: "0.39.9",
    dir: "/work",
    os: "linux",
    arch: "amd64",
  });
  assertEquals(res.skipped, true);
  assertEquals(h.ops.length, 0);
});

Deno.test("installBinary overwrites an existing binary with force", async () => {
  const zip = await buildZip([{ name: "pocketbase", body: BODY }]);
  const h = harness({
    zip,
    checksums: `${await sha256Hex(zip)}  ${ASSET}`,
    existing: ["/work/pocketbase"],
  });
  const res = await installBinary(h.deps, {
    version: "0.39.9",
    dir: "/work",
    force: true,
    os: "linux",
    arch: "amd64",
  });
  assertEquals(res.skipped, false);
  assertEquals(h.files.get("/work/pocketbase"), BODY);
});

Deno.test("installBinary names the windows binary pocketbase.exe", async () => {
  const zip = await buildZip([{ name: "pocketbase.exe", body: BODY }]);
  const h = harness({
    zip,
    checksums: `${await sha256Hex(zip)}  pocketbase_0.39.9_windows_amd64.zip`,
  });
  const res = await installBinary(h.deps, {
    version: "0.39.9",
    dir: "/work",
    os: "windows",
    arch: "amd64",
  });
  assertEquals(res.path, "/work/pocketbase.exe");
});

Deno.test("pinVersion creates pbc.json when absent", async () => {
  const h = harness({});
  await pinVersion(h.deps, "/work", "0.39.9");
  assertEquals(JSON.parse(h.texts.get("/work/pbc.json")!), {
    pocketbaseVersion: "0.39.9",
  });
});

Deno.test("pinVersion preserves an existing cloud link", async () => {
  const h = harness({});
  h.texts.set(
    "/work/pbc.json",
    JSON.stringify({
      projectId: "p1",
      kind: "pocketbases",
      environments: { production: { id: "pb1", name: "main" } },
    }),
  );
  await pinVersion(h.deps, "/work", "0.39.9");
  assertEquals(JSON.parse(h.texts.get("/work/pbc.json")!), {
    projectId: "p1",
    kind: "pocketbases",
    environments: { production: { id: "pb1", name: "main" } },
    pocketbaseVersion: "0.39.9",
  });
});

Deno.test("pinVersion replaces an older pin", async () => {
  const h = harness({});
  h.texts.set(
    "/work/pbc.json",
    JSON.stringify({ pocketbaseVersion: "0.34.2" }),
  );
  await pinVersion(h.deps, "/work", "0.39.9");
  assertEquals(
    JSON.parse(h.texts.get("/work/pbc.json")!).pocketbaseVersion,
    "0.39.9",
  );
});

Deno.test("pinVersion overwrites unparseable pbc.json rather than failing", async () => {
  const h = harness({});
  h.texts.set("/work/pbc.json", "{ this is not json");
  await pinVersion(h.deps, "/work", "0.39.9");
  assertEquals(JSON.parse(h.texts.get("/work/pbc.json")!), {
    pocketbaseVersion: "0.39.9",
  });
});

Deno.test("readPin returns the pin, or null when there is none", async () => {
  const h = harness({});
  assertEquals(await readPin(h.deps, "/work"), null);
  h.texts.set(
    "/work/pbc.json",
    JSON.stringify({ pocketbaseVersion: "0.39.9" }),
  );
  assertEquals(await readPin(h.deps, "/work"), "0.39.9");
  h.texts.set("/work/pbc.json", JSON.stringify({ projectId: "p1" }));
  assertEquals(await readPin(h.deps, "/work"), null);
});

Deno.test("pinVersion writes into a pre-0.6.0 pb.json rather than beside it", async () => {
  const h = harness({});
  h.texts.set("/work/pb.json", JSON.stringify({ projectId: "p1" }));
  await pinVersion(h.deps, "/work", "0.39.9");
  assertEquals(JSON.parse(h.texts.get("/work/pb.json")!), {
    projectId: "p1",
    pocketbaseVersion: "0.39.9",
  });
  assertEquals(h.texts.has("/work/pbc.json"), false);
  assertEquals(await readPin(h.deps, "/work"), "0.39.9");
});
