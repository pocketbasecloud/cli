import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  describeStandaloneResult,
  ensureStandaloneOutput,
  readOutput,
  scanSource,
} from "../../../src/build/next-config.ts";
import { CliError } from "../../../src/errors.ts";

function dir(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

async function fix(
  name: string,
  body: string,
  extra: Record<string, string> = {},
): Promise<{ action: string; file: string; text: string }> {
  const cwd = dir({ [name]: body, ...extra });
  const res = await ensureStandaloneOutput(cwd);
  return {
    ...res,
    text: await Deno.readTextFile(join(cwd, res.file)),
  };
}

Deno.test("adds output to a const-and-export-default config", async () => {
  const { action, text } = await fix(
    "next.config.mjs",
    `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  reactStrictMode: true,\n};\n\nexport default nextConfig;\n`,
  );
  assertEquals(action, "added");
  assertEquals(
    text,
    `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  reactStrictMode: true,\n  output: "standalone",\n};\n\nexport default nextConfig;\n`,
  );
});

Deno.test("adds output to an empty config object", async () => {
  const { text } = await fix(
    "next.config.js",
    `const nextConfig = {};\n\nmodule.exports = nextConfig;\n`,
  );
  assertEquals(
    text,
    `const nextConfig = { output: "standalone" };\n\nmodule.exports = nextConfig;\n`,
  );
});

Deno.test("adds output to an inline module.exports object", async () => {
  const { text } = await fix(
    "next.config.js",
    `module.exports = {\n  images: { domains: ["a.com"] },\n};\n`,
  );
  assertEquals(
    text,
    `module.exports = {\n  images: { domains: ["a.com"] },\n  output: "standalone",\n};\n`,
  );
});

Deno.test("adds a separating comma when the last property has none", async () => {
  const { text } = await fix(
    "next.config.js",
    `export default {\n  reactStrictMode: true\n}\n`,
  );
  assertEquals(
    text,
    `export default {\n  reactStrictMode: true,\n  output: "standalone",\n}\n`,
  );
});

Deno.test("adds output inside a plugin wrapper's inline object", async () => {
  const { text } = await fix(
    "next.config.js",
    `const withPWA = require("next-pwa");\n\nmodule.exports = withPWA({\n  dest: "public",\n});\n`,
  );
  assertStringIncludes(text, `  dest: "public",\n  output: "standalone",\n});`);
});

Deno.test("follows a plugin wrapper to the config variable it wraps", async () => {
  const { text } = await fix(
    "next.config.mjs",
    `import createMDX from "@next/mdx";\n\nconst nextConfig = {\n  pageExtensions: ["md", "tsx"],\n};\n\nconst withMDX = createMDX();\n\nexport default withMDX(nextConfig);\n`,
  );
  assertStringIncludes(
    text,
    `  pageExtensions: ["md", "tsx"],\n  output: "standalone",\n};`,
  );
});

Deno.test("handles a called-then-applied wrapper", async () => {
  const { text } = await fix(
    "next.config.js",
    `module.exports = withBundleAnalyzer({ enabled: true })({\n  poweredByHeader: false,\n});\n`,
  );
  assertStringIncludes(
    text,
    `  poweredByHeader: false,\n  output: "standalone",\n});`,
  );
});

Deno.test("adds output to a typed TypeScript config", async () => {
  const { file, text } = await fix(
    "next.config.ts",
    `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  reactStrictMode: true,\n};\n\nexport default nextConfig;\n`,
  );
  assertEquals(file, "next.config.ts");
  assertStringIncludes(
    text,
    `  reactStrictMode: true,\n  output: "standalone",\n};`,
  );
});

Deno.test("leaves a config that already builds standalone untouched", async () => {
  const body = `module.exports = { output: "standalone" };\n`;
  const { action, text } = await fix("next.config.js", body);
  assertEquals(action, "ok");
  assertEquals(text, body);
});

Deno.test("is idempotent — a second run changes nothing", async () => {
  const cwd = dir({
    "next.config.mjs":
      `const nextConfig = {\n  reactStrictMode: true,\n};\n\nexport default nextConfig;\n`,
  });
  assertEquals((await ensureStandaloneOutput(cwd)).action, "added");
  const once = await Deno.readTextFile(join(cwd, "next.config.mjs"));
  assertEquals((await ensureStandaloneOutput(cwd)).action, "ok");
  assertEquals(await Deno.readTextFile(join(cwd, "next.config.mjs")), once);
});

Deno.test("recognises a quoted output key", async () => {
  const { action } = await fix(
    "next.config.js",
    `module.exports = { "output": "standalone" };\n`,
  );
  assertEquals(action, "ok");
});

Deno.test("ignores output mentioned only in a comment", async () => {
  const { action, text } = await fix(
    "next.config.js",
    `// output: "export" was removed\nmodule.exports = {\n  trailingSlash: true,\n};\n`,
  );
  assertEquals(action, "added");
  assertStringIncludes(text, `  output: "standalone",\n};`);
});

Deno.test("ignores a webpack output object and still adds the Next one", async () => {
  const { text } = await fix(
    "next.config.js",
    `module.exports = {\n  webpack(config) {\n    return { ...config, output: { ...config.output, publicPath: "/" } };\n  },\n};\n`,
  );
  assertStringIncludes(text, `  output: "standalone",\n};`);
});

Deno.test("a plugin's own output option does not stand in for the config's", async () => {
  const { action, text } = await fix(
    "next.config.js",
    `const nextConfig = {\n  compress: true,\n};\n\nmodule.exports = withMDX({ output: "export" })(nextConfig);\n`,
  );
  assertEquals(action, "added");
  assertStringIncludes(text, `  compress: true,\n  output: "standalone",\n};`);
  assertStringIncludes(text, `withMDX({ output: "export" })`);
});

Deno.test("a webpack output built from another value is not mistaken for the config's", async () => {
  const { action } = await fix(
    "next.config.js",
    `module.exports = {\n  webpack(config) {\n    return { ...config, output: config.output };\n  },\n};\n`,
  );
  assertEquals(action, "added");
});

Deno.test("refuses a static-export config and names the frontend command", async () => {
  await assertRejects(
    () => fix("next.config.js", `module.exports = { output: "export" };\n`),
    CliError,
    "pbc cloud frontend deploy",
  );
});

Deno.test("refuses an output value it cannot read", async () => {
  await assertRejects(
    () =>
      fix(
        "next.config.js",
        `module.exports = { output: process.env.NEXT_OUTPUT };\n`,
      ),
    CliError,
    "computes its",
  );
});

Deno.test("refuses a function-form config rather than guessing", async () => {
  await assertRejects(
    () =>
      fix(
        "next.config.js",
        `module.exports = (phase) => ({ reactStrictMode: true });\n`,
      ),
    CliError,
    "not a plain object literal",
  );
});

Deno.test("creates next.config.mjs for an ESM package", async () => {
  const cwd = dir({ "package.json": `{ "type": "module" }` });
  const res = await ensureStandaloneOutput(cwd);
  assertEquals(res, { action: "created", file: "next.config.mjs" });
  const text = await Deno.readTextFile(join(cwd, "next.config.mjs"));
  assertStringIncludes(text, `output: "standalone"`);
  assertStringIncludes(text, "export default nextConfig;");
});

Deno.test("creates next.config.js for a CommonJS package", async () => {
  const cwd = dir({ "package.json": `{ "name": "api" }` });
  const res = await ensureStandaloneOutput(cwd);
  assertEquals(res, { action: "created", file: "next.config.js" });
  const text = await Deno.readTextFile(join(cwd, "next.config.js"));
  assertStringIncludes(text, "module.exports = nextConfig;");
});

Deno.test("a created config is picked up by the next run", async () => {
  const cwd = dir({ "package.json": `{ "type": "module" }` });
  assertEquals((await ensureStandaloneOutput(cwd)).action, "created");
  assertEquals((await ensureStandaloneOutput(cwd)).action, "ok");
});

Deno.test("scanSource blanks braces inside strings and comments", () => {
  const src = 'const a = "{"; /* } */ const b = `${x}`;';
  const { mask } = scanSource(src);
  assertEquals(mask.length, src.length);
  assertEquals(mask.includes("{"), false);
  assertEquals(mask.includes("}"), false);
});

Deno.test("scanSource does not desync on a regex holding a quote", () => {
  const { code } = scanSource(`const r = /['"]/;\nconst out = "kept";`);
  assertStringIncludes(code, `"kept"`);
});

Deno.test("matches the quote style the code uses, not the comments'", async () => {
  const { text } = await fix(
    "next.config.js",
    `/** @type {import('next').NextConfig} */\nmodule.exports = { trailingSlash: true };\n`,
  );
  assertStringIncludes(text, `output: "standalone"`);
  const single = await fix(
    "next.config.js",
    `module.exports = { images: { domains: ['a.com'] } };\n`,
  );
  assertStringIncludes(single.text, `output: 'standalone'`);
});

Deno.test("readOutput reads the literal value", () => {
  const src = `module.exports = { output: 'export' };`;
  assertEquals(readOutput(scanSource(src).code, src), "export");
});

Deno.test("describeStandaloneResult stays quiet when nothing changed", () => {
  assertEquals(
    describeStandaloneResult({ action: "ok", file: "next.config.js" }),
    undefined,
  );
  assertStringIncludes(
    describeStandaloneResult({ action: "added", file: "next.config.js" }) ?? "",
    'Added output: "standalone" to next.config.js',
  );
});
