import { assertEquals, assertStringIncludes } from "@std/assert";
import { makeSelfCommands } from "../../../src/commands/self.ts";
import { silentProgress } from "../../../src/ui/progress.ts";
import type { SelfDeps } from "../../../src/self/upgrade.ts";
import type { CmdCtx } from "../../../src/command.ts";
import { VERSION } from "../../../src/version.ts";
import { sha256Hex } from "../../../src/hash.ts";
import { buildTarGz } from "../../mocks/tar.mock.ts";

const enc = new TextEncoder();
const BODY = enc.encode("#!/fake/pb binary\n");

function newer(): string {
  const [maj, min, patch] = VERSION.split("-")[0].split(".").map(Number);
  return `${maj}.${min}.${patch + 1}`;
}

function ctx(args: string[] = [], json = false): CmdCtx {
  return {
    args,
    flags: {
      json,
      yes: false,
      noInput: false,
      interactive: false,
    },
  };
}

function deps(opts: {
  release?: string;
  execPath?: string;
  archive?: Uint8Array;
} = {}): SelfDeps {
  const release = opts.release ?? newer();
  const files = new Map<string, Uint8Array>();
  return {
    fetch: (async (url: string | URL | Request) => {
      if (String(url).endsWith("checksums.txt")) {
        const digest = opts.archive
          ? await sha256Hex(opts.archive)
          : "0".repeat(64);
        return new Response(
          `${digest}  pb_${release}_linux_x64.tar.gz\n`,
          { status: 200 },
        );
      }
      return new Response(opts.archive as BufferSource, { status: 200 });
    }) as unknown as typeof fetch,
    cwd: () => "/work",
    readTextFile: () => Promise.reject(new Deno.errors.NotFound("x")),
    writeFile: (p, d) => {
      files.set(p, d);
      return Promise.resolve();
    },
    writeTextFile: () => Promise.resolve(),
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
    stat: (p) => Promise.resolve(files.has(p) ? { isFile: true } : null),
    remove: (p) => {
      files.delete(p);
      return Promise.resolve();
    },
    env: () => undefined,
    execPath: () => opts.execPath ?? "/usr/local/bin/pb",
    hostKey: () => "linux-x64",
  };
}

function run(d: SelfDeps) {
  const out: string[] = [];
  const cmd =
    makeSelfCommands(d, (s) => out.push(s), silentProgress())["self upgrade"];
  return { cmd, out };
}

Deno.test("upgrade --check reports the available version without installing", async () => {
  const { cmd, out } = run(deps());
  assertEquals(await cmd.run({ check: true }, ctx()), 0);
  const text = out.join("\n");
  assertStringIncludes(text, `Installed: pbc ${VERSION} (standalone)`);
  assertStringIncludes(text, `Latest:    pbc ${newer()}`);
  assertStringIncludes(text, "Run `pbc self upgrade` to update.");
});

Deno.test("upgrade --check says so when already current", async () => {
  const { cmd, out } = run(deps({ release: VERSION }));
  assertEquals(await cmd.run({ check: true }, ctx()), 0);
  assertStringIncludes(out.join("\n"), "You are up to date.");
});

Deno.test("upgrade --check --json emits a machine-readable report", async () => {
  const { cmd, out } = run(deps());
  assertEquals(await cmd.run({ check: true }, ctx([], true)), 0);
  const j = JSON.parse(out[0]).data;
  assertEquals(j.current, VERSION);
  assertEquals(j.latest, newer());
  assertEquals(j.updateAvailable, true);
  assertEquals(j.install, "standalone");
});

Deno.test("upgrade --check never installs, even with --force", async () => {
  const d = deps({ release: VERSION });
  let fetched = 0;
  const orig = d.fetch;
  d.fetch = ((u: string | URL | Request, i?: RequestInit) => {
    fetched++;
    return orig(u, i);
  }) as unknown as typeof fetch;

  const { cmd } = run(d);
  assertEquals(await cmd.run({ check: true, force: true }, ctx()), 0);
  assertEquals(fetched, 1);
});

Deno.test("upgrade is a no-op when already on the latest version", async () => {
  const { cmd, out } = run(deps({ release: VERSION }));
  assertEquals(await cmd.run({}, ctx()), 0);
  assertStringIncludes(out.join("\n"), "already the latest version");
});

Deno.test("upgrade exits non-zero and names the command for an npm install", async () => {
  const { cmd, out } = run(
    deps({ execPath: "/x/node_modules/@pocketbasecloud/cli-linux-x64/bin/pb" }),
  );
  assertEquals(await cmd.run({}, ctx()), 1);
  const text = out.join("\n");
  assertStringIncludes(text, "installed with npm");
  assertStringIncludes(text, "npm i -g @pocketbasecloud/cli@latest");
});

Deno.test("upgrade does not print Deno's path for a source install", async () => {
  const { cmd, out } = run(deps({ execPath: "/home/t/.deno/bin/deno" }));
  assertEquals(await cmd.run({}, ctx()), 1);
  const text = out.join("\n");
  assertStringIncludes(text, "runs from source");
  assertEquals(text.includes("/home/t/.deno/bin/deno"), false);
});

Deno.test("upgrade --json signals failure for an install it cannot replace", async () => {
  const { cmd, out } = run(
    deps({ execPath: "/x/node_modules/@pocketbasecloud/cli-linux-x64/bin/pb" }),
  );
  assertEquals(await cmd.run({}, ctx([], true)), 1);
  const j = JSON.parse(out[0]).data;
  assertEquals(j.upgraded, false);
  assertEquals(j.action, "manual");
  assertEquals(j.command, "npm i -g @pocketbasecloud/cli@latest");
});

Deno.test("upgrade replaces a standalone binary and reports the move", async () => {
  const archive = await buildTarGz([{ name: "pb", body: BODY }]);
  const { cmd, out } = run(deps({ archive }));
  assertEquals(await cmd.run({}, ctx()), 0);
  assertStringIncludes(
    out.join("\n"),
    `Upgraded pbc ${VERSION} → ${newer()} (/usr/local/bin/pb)`,
  );
});

Deno.test("upgrade --json reports a completed upgrade", async () => {
  const archive = await buildTarGz([{ name: "pb", body: BODY }]);
  const { cmd, out } = run(deps({ archive }));
  assertEquals(await cmd.run({}, ctx([], true)), 0);
  const j = JSON.parse(out[0]).data;
  assertEquals(j.upgraded, true);
  assertEquals(j.target, newer());
  assertEquals(j.path, "/usr/local/bin/pb");
});

Deno.test("upgrade installs an explicitly requested older version", async () => {
  const archive = await buildTarGz([{ name: "pb", body: BODY }]);
  const { cmd, out } = run(deps({ archive, release: "0.0.1" }));
  assertEquals(await cmd.run({}, ctx(["0.0.1"])), 0);
  assertStringIncludes(out.join("\n"), `Switched pbc ${VERSION} → 0.0.1`);
});

Deno.test("upgrade does not call a requested rollback an available update", async () => {
  const { cmd, out } = run(
    deps({
      release: "0.0.1",
      execPath: "/x/node_modules/@pocketbasecloud/cli-linux-x64/bin/pb",
    }),
  );
  assertEquals(await cmd.run({}, ctx(["0.0.1"])), 1);
  const text = out.join("\n");
  assertStringIncludes(text, `pbc 0.0.1 requested; this is pbc ${VERSION}`);
  assertEquals(text.includes("is available"), false);
});
