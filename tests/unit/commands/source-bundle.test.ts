import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  buildBundle,
  sourceHints,
} from "../../../src/commands/deploy-helper.ts";
import { extractFiles } from "../../../src/local/unzip.ts";

function dir(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

Deno.test("a website --source bundle holds the source without building it", async () => {
  const cwd = dir({
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "vite.config.ts": "export default {}",
    "src/main.ts": "console.log(1)",
    "dist/index.html": "<h1>built</h1>",
    ".next/cache/x": "x",
    "node_modules/vite/index.js": "x",
    ".env": "SECRET=1",
  });
  const ran: string[] = [];
  const bundle = await buildBundle({
    cwd,
    kind: "frontends",
    skipBuild: false,
    source: true,
    log: () => {},
    run: (command) => {
      ran.push(command);
      return Promise.resolve({ code: 0 });
    },
  });
  assertEquals(ran, []);
  assertEquals(
    [...(await extractFiles(bundle.bytes)).keys()].sort(),
    ["package.json", "pbc.json", "src/main.ts", "vite.config.ts"],
  );
  assertEquals(sourceHints(bundle.build), {
    command: bundle.build.command,
    outputDir: "dist",
  });
});

Deno.test("sourceHints passes a copy's build env and leaves out what is unset", () => {
  assertEquals(sourceHints({}, { API_URL: "x" }), { env: { API_URL: "x" } });
  assertEquals(sourceHints({}), {});
});
