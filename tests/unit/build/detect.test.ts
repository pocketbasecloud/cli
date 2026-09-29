import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  detectPackageManager,
  detectPythonVersion,
  inferBuild,
} from "../../../src/build/detect.ts";
import { UnsupportedPythonError } from "../../../src/build/python-detect.ts";

function dir(files: Record<string, string> = {}): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

const pkg = (scripts: Record<string, string> = {}) =>
  JSON.stringify({ name: "x", scripts });

Deno.test("detectPackageManager prefers bun, then pnpm, then yarn, else npm", async () => {
  assertEquals(await detectPackageManager(dir()), "npm");
  assertEquals(await detectPackageManager(dir({ "yarn.lock": "" })), "yarn");
  assertEquals(
    await detectPackageManager(dir({ "pnpm-lock.yaml": "" })),
    "pnpm",
  );
  assertEquals(
    await detectPackageManager(
      dir({ "bun.lockb": "", "pnpm-lock.yaml": "", "yarn.lock": "" }),
    ),
    "bun",
  );
});

Deno.test("frontend inference maps each framework to its output directory", async () => {
  const cases: [Record<string, string>, string][] = [
    [
      { "vite.config.ts": "", "package.json": pkg({ build: "vite build" }) },
      "dist",
    ],
    [
      { "svelte.config.js": "", "package.json": pkg({ build: "vite build" }) },
      "build",
    ],
    [
      { "astro.config.mjs": "", "package.json": pkg({ build: "astro build" }) },
      "dist",
    ],
    [
      { "angular.json": "", "package.json": pkg({ build: "ng build" }) },
      "dist",
    ],
    [
      { "next.config.js": "", "package.json": pkg({ build: "next build" }) },
      "out",
    ],
  ];
  for (const [files, expected] of cases) {
    const cfg = await inferBuild(dir(files), "frontends");
    assertEquals(cfg.outputDir, expected);
    assertEquals(cfg.command, "npm run build");
  }
});

Deno.test("frontend inference picks an existing dist/build/out with no framework config", async () => {
  const root = dir({ "package.json": pkg({ build: "make" }) });
  Deno.mkdirSync(join(root, "build"));
  assertEquals((await inferBuild(root, "frontends")).outputDir, "build");
});

Deno.test("frontend inference yields no command when package.json has no build script", async () => {
  const cfg = await inferBuild(dir({ "package.json": pkg() }), "frontends");
  assertEquals(cfg.command, undefined);
  assertEquals(cfg.outputDir, ".");
});

Deno.test("frontend inference uses the detected package manager", async () => {
  const cfg = await inferBuild(
    dir({
      "vite.config.js": "",
      "yarn.lock": "",
      "package.json": pkg({ build: "vite build" }),
    }),
    "frontends",
  );
  assertEquals(cfg.command, "yarn run build");
});

Deno.test("backend inference maps manifests to runtimes", async () => {
  assertEquals(
    (await inferBuild(dir({ "deno.json": "{}" }), "backends")).runtime,
    "deno",
  );
  assertEquals(
    (await inferBuild(dir({ "deno.jsonc": "{}" }), "backends")).runtime,
    "deno",
  );
  assertEquals(
    (await inferBuild(dir({ "bun.lockb": "" }), "backends")).runtime,
    "bun",
  );
  assertEquals(
    (await inferBuild(dir({ "package.json": pkg() }), "backends")).runtime,
    "nodejs",
  );
});

Deno.test("backend inference detects nextjs and keeps its build command", async () => {
  const cfg = await inferBuild(
    dir({
      "next.config.mjs": "",
      "package.json": pkg({ build: "next build" }),
    }),
    "backends",
  );
  assertEquals(cfg.runtime, "nextjs");
  assertEquals(cfg.command, "npm run build");
  assertEquals(cfg.outputDir, undefined);
});

Deno.test("backend inference beats deno.json with next.config", async () => {
  const cfg = await inferBuild(
    dir({ "next.config.ts": "", "deno.json": "{}" }),
    "backends",
  );
  assertEquals(cfg.runtime, "nextjs");
});

Deno.test("backend inference falls back to shipping the directory as-is", async () => {
  const cfg = await inferBuild(dir(), "backends");
  assertEquals(cfg.runtime, undefined);
  assertEquals(cfg.outputDir, ".");
});

Deno.test("pocketbase inference records only the directories that exist", async () => {
  const root = dir({ "pb_hooks/main.pb.js": "//" });
  Deno.mkdirSync(join(root, "pb_migrations"));
  const cfg = await inferBuild(root, "pocketbases");
  assertEquals(cfg.pbHooks, "pb_hooks");
  assertEquals(cfg.pbMigrations, "pb_migrations");
  assertEquals(cfg.pbPublic, undefined);
});

Deno.test("pocketbase inference yields an empty config when none of the three exist", async () => {
  const cfg = await inferBuild(dir(), "pocketbases");
  assertEquals(cfg.pbPublic, undefined);
  assertEquals(cfg.pbHooks, undefined);
  assertEquals(cfg.pbMigrations, undefined);
});

Deno.test("backend inference reads the project's own start task/script", async () => {
  assertEquals(
    (await inferBuild(
      dir({
        "deno.json": JSON.stringify({ tasks: { start: "deno run -A m.ts" } }),
      }),
      "backends",
    )).startCommand,
    "deno task start",
  );
  assertEquals(
    (await inferBuild(
      dir({ "package.json": pkg({ start: "node s.js" }) }),
      "backends",
    ))
      .startCommand,
    "npm run start",
  );
  assertEquals(
    (await inferBuild(
      dir({ "package.json": pkg({ start: "bun s.ts" }), "bun.lockb": "" }),
      "backends",
    )).startCommand,
    "bun run start",
  );
});

Deno.test("backend inference leaves startCommand unset when nothing declares one", async () => {
  assertEquals(
    (await inferBuild(dir({ "deno.json": "{}" }), "backends")).startCommand,
    undefined,
  );
  assertEquals(
    (await inferBuild(dir({ "package.json": pkg() }), "backends")).startCommand,
    undefined,
  );
});

Deno.test("backend inference detects a bare python script", async () => {
  const cfg = await inferBuild(dir({ "main.py": "print('hi')\n" }), "backends");
  assertEquals(cfg.runtime, "python");
  assertEquals(cfg.startCommand, "python main.py");
  assertEquals(cfg.outputDir, ".");
});

Deno.test("backend inference prefers main.py, then app.py, then server.py, then a lone script", async () => {
  const cmd = async (files: Record<string, string>) =>
    (await inferBuild(dir(files), "backends")).startCommand;
  assertEquals(await cmd({ "main.py": "", "app.py": "" }), "python main.py");
  assertEquals(await cmd({ "app.py": "", "server.py": "" }), "python app.py");
  assertEquals(
    await cmd({ "server.py": "", "other.py": "" }),
    "python server.py",
  );
  assertEquals(await cmd({ "worker.py": "" }), "python worker.py");
});

Deno.test("backend inference leaves python startCommand unset when the entry is ambiguous", async () => {
  const cfg = await inferBuild(dir({ "a.py": "", "b.py": "" }), "backends");
  assertEquals(cfg.runtime, "python");
  assertEquals(cfg.startCommand, undefined);
});

Deno.test("backend inference prefers js runtimes over a stray python file", async () => {
  const cfg = await inferBuild(
    dir({ "package.json": pkg(), "main.py": "" }),
    "backends",
  );
  assertEquals(cfg.runtime, "nodejs");
});

Deno.test("backend inference detects python from requirements.txt", async () => {
  const cfg = await inferBuild(
    dir({ "requirements.txt": "requests==2.31.0\n", "app.py": "" }),
    "backends",
  );
  assertEquals(cfg.runtime, "python");
  assertEquals(cfg.startCommand, "python app.py");
  assertEquals(cfg.outputDir, ".");
});

Deno.test("backend inference detects python from requirements.txt alone", async () => {
  const cfg = await inferBuild(
    dir({ "requirements.txt": "requests==2.31.0\n" }),
    "backends",
  );
  assertEquals(cfg.runtime, "python");
  assertEquals(cfg.startCommand, undefined);
});

Deno.test("backend inference detects every python dependency file", async () => {
  for (
    const manifest of [
      "requirements.txt",
      "pyproject.toml",
      "poetry.lock",
      "Pipfile",
      "Pipfile.lock",
      "uv.lock",
    ]
  ) {
    const cfg = await inferBuild(dir({ [manifest]: "" }), "backends");
    assertEquals(cfg.runtime, "python", manifest);
    assertEquals(cfg.startCommand, undefined, manifest);
    assertEquals(cfg.outputDir, ".", manifest);
  }
  const withEntry = await inferBuild(
    dir({ "pyproject.toml": "", "app.py": "" }),
    "backends",
  );
  assertEquals(withEntry.startCommand, "python app.py");
});

Deno.test("backend inference leaves the python version to each deploy", async () => {
  const cfg = await inferBuild(
    dir({ "main.py": "", ".python-version": "3.11\n" }),
    "backends",
  );
  assertEquals(cfg.pythonVersion, undefined);
});

Deno.test("backend inference serves a framework app on $PORT", async () => {
  const cfg = await inferBuild(
    dir({
      "requirements.txt": "flask\ngunicorn\n",
      "app/__init__.py":
        "from flask import Flask\n\ndef create_app():\n    return Flask(__name__)\n",
      "wsgi.py": "from app import create_app\n\napp = create_app()\n",
    }),
    "backends",
  );
  assertEquals(cfg.startCommand, "gunicorn wsgi:app --bind 0.0.0.0:$PORT");
});

Deno.test("backend inference skips a committed virtualenv", async () => {
  const cfg = await inferBuild(
    dir({
      "requirements.txt": "flask\n",
      "env/pyvenv.cfg": "home = /usr/bin\n",
      "env/app.py": "from flask import Flask\n\napp = Flask(__name__)\n",
    }),
    "backends",
  );
  assertEquals(cfg.runtime, "python");
  assertEquals(cfg.startCommand, undefined);
});

Deno.test("detectPythonVersion refuses a Python 2 pin", async () => {
  await assertRejects(
    () =>
      detectPythonVersion(
        dir({ "main.py": "", ".python-version": "2.7.18\n" }),
      ),
    UnsupportedPythonError,
    "Python 2 is not supported",
  );
});
