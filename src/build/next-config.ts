import { join } from "@std/path";
import { CliError } from "../errors.ts";

const CONFIG_NAMES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.cjs",
  "next.config.mts",
  "next.config.cts",
];

export type StandaloneResult =
  | { action: "ok"; file: string }
  | { action: "added"; file: string }
  | { action: "created"; file: string };

async function readIfFile(path: string): Promise<string | null> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) return null;
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

export function scanSource(src: string): { code: string; mask: string } {
  const code = src.split("");
  const mask = src.split("");
  const blank = (from: number, to: number, both: boolean) => {
    for (let k = from; k < to && k < src.length; k++) {
      if (src[k] === "\n") continue;
      mask[k] = " ";
      if (both) code[k] = " ";
    }
  };

  let i = 0;
  let prev = "";
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      blank(i, stop, true);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop, true);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === "\\") {
          k += 2;
          continue;
        }
        if (src[k] === c) break;
        k++;
      }
      blank(i + 1, Math.min(k, src.length), false);
      i = Math.min(k, src.length) + 1;
      prev = c;
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%~^".includes(prev))) {
      let k = i + 1;
      let inClass = false;
      while (k < src.length) {
        const d = src[k];
        if (d === "\\") {
          k += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        k++;
      }
      blank(i, Math.min(k + 1, src.length), true);
      i = Math.min(k + 1, src.length);
      prev = "/";
      continue;
    }

    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code: code.join(""), mask: mask.join("") };
}

const OUTPUT_KEY = /(?:^|[^\w$.])(["']?)output\1\s*:\s*/g;

export type Scope = { mask: string; open: number; close: number };

function isOwnProperty(s: Scope, index: number): boolean {
  if (index < s.open || index > s.close) return false;
  let depth = 0;
  for (let i = s.open; i < index; i++) {
    if (s.mask[i] === "{") depth++;
    else if (s.mask[i] === "}") depth--;
  }
  return depth === 1;
}

export function readOutput(
  code: string,
  src: string,
  scope?: Scope,
): string | "computed" | null {
  let computed = false;
  for (const m of code.matchAll(OUTPUT_KEY)) {
    if (scope && !isOwnProperty(scope, m.index)) continue;
    const valueAt = m.index + m[0].length;
    const quote = code[valueAt];
    if (quote === '"' || quote === "'") {
      const end = src.indexOf(quote, valueAt + 1);
      if (end !== -1) return src.slice(valueAt + 1, end);
    }
    if (code[valueAt] !== "{") computed = true;
  }
  return computed ? "computed" : null;
}

export function findConfigObject(mask: string): number {
  const assignment = /(?:module\.exports|export\s+default)\s*=?\s*/;
  const m = assignment.exec(mask);
  if (!m) return -1;
  return resolveObject(mask, m.index + m[0].length, 0);
}

function resolveObject(mask: string, from: number, depth: number): number {
  if (depth > 5) return -1;
  let i = from;
  while (i < mask.length && /\s/.test(mask[i])) i++;
  if (mask[i] === "{") return i;

  const ident = /^[A-Za-z_$][\w$]*/.exec(mask.slice(i));
  if (!ident) return -1;
  let j = i + ident[0].length;
  while (j < mask.length && /\s/.test(mask[j])) j++;

  if (mask[j] === "(") {
    let last = j;
    while (true) {
      const close = matchDelimiter(mask, last, "(", ")");
      if (close === -1) return -1;
      let k = close + 1;
      while (k < mask.length && /\s/.test(mask[k])) k++;
      if (mask[k] !== "(") break;
      last = k;
    }
    return resolveObject(mask, last + 1, depth + 1);
  }

  const decl = new RegExp(
    `(?:const|let|var)\\s+${ident[0]}\\s*(?::[^=;]+)?=\\s*`,
  ).exec(mask);
  if (!decl) return -1;
  return resolveObject(mask, decl.index + decl[0].length, depth + 1);
}

export function matchDelimiter(
  mask: string,
  open: number,
  openCh: string,
  closeCh: string,
): number {
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    if (mask[i] === openCh) depth++;
    else if (mask[i] === closeCh && --depth === 0) return i;
  }
  return -1;
}

function quoteStyle(code: string): string {
  const single = (code.match(/'/g) ?? []).length;
  const double = (code.match(/"/g) ?? []).length;
  return single > double ? "'" : '"';
}

export function insertOutput(
  src: string,
  open: number,
  close: number,
  code = src,
): string {
  const q = quoteStyle(code);
  const prop = `output: ${q}standalone${q}`;
  const head = src.slice(0, close).replace(/\s+$/, "");
  const comma = /[,{]$/.test(head) ? "" : ",";

  if (!src.slice(open, close).includes("\n")) {
    return `${head}${comma} ${prop} ${src.slice(close)}`;
  }
  const lineStart = src.lastIndexOf("\n", close - 1) + 1;
  const closeIndent = /^[ \t]*$/.test(src.slice(lineStart, close))
    ? src.slice(lineStart, close)
    : "";
  return `${head}${comma}\n${closeIndent}  ${prop},\n${closeIndent}${
    src.slice(close)
  }`;
}

async function isEsm(cwd: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await Deno.readTextFile(join(cwd, "package.json")));
    return pkg?.type === "module";
  } catch {
    return false;
  }
}

function newConfig(esm: boolean): string {
  return `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n` +
    `  // Required by PocketBase Cloud: backends deploy as a prebuilt bundle.\n` +
    `  output: "standalone",\n};\n\n` +
    (esm ? `export default nextConfig;\n` : `module.exports = nextConfig;\n`);
}

export async function readNextOutput(
  cwd: string,
): Promise<{ file: string; output: string | "computed" | null } | null> {
  const found = await findNextConfig(cwd);
  if (!found) return null;
  const { code, mask } = scanSource(found.src);
  const open = findConfigObject(mask);
  const close = open === -1 ? -1 : matchDelimiter(mask, open, "{", "}");
  return {
    file: found.file,
    output: readOutput(
      code,
      found.src,
      close === -1 ? undefined : { mask, open, close },
    ),
  };
}

async function findNextConfig(
  cwd: string,
): Promise<{ file: string; src: string } | null> {
  for (const name of CONFIG_NAMES) {
    const text = await readIfFile(join(cwd, name));
    if (text !== null) return { file: name, src: text };
  }
  return null;
}

export async function ensureStandaloneOutput(
  cwd: string,
): Promise<StandaloneResult> {
  const found = await findNextConfig(cwd);
  const file = found?.file;
  const src = found?.src;

  if (file === undefined || src === undefined) {
    const created = await isEsm(cwd) ? "next.config.mjs" : "next.config.js";
    await Deno.writeTextFile(
      join(cwd, created),
      newConfig(created.endsWith(".mjs")),
    );
    return { action: "created", file: created };
  }

  const { code, mask } = scanSource(src);
  const open = findConfigObject(mask);
  const close = open === -1 ? -1 : matchDelimiter(mask, open, "{", "}");
  const output = readOutput(
    code,
    src,
    close === -1 ? undefined : { mask, open, close },
  );
  if (output === "standalone") return { action: "ok", file };
  if (output === "export") {
    throw new CliError(
      `${file} sets output: "export", which builds a static site, not a ` +
        `server. Deploy it with \`pbc cloud frontend deploy\`, or remove that ` +
        `line to deploy it as a Next.js backend.`, { code: "USAGE" });
  }
  if (output !== null) {
    throw new CliError(
      output === "computed"
        ? `${file} computes its "output" value, so the CLI cannot tell what ` +
          `the build produces. Set output: "standalone" there and deploy again.`
        : `${file} sets output: "${output}". Next.js backends must be built ` +
          `with output: "standalone" — change it and deploy again.`,
          { code: "USAGE" });
  }

  if (close === -1) {
    throw new CliError(
      `Could not add output: "standalone" to ${file} automatically — its ` +
        `config is not a plain object literal. Add output: "standalone" to ` +
        `the config it exports and deploy again.`, { code: "USAGE" });
  }
  await Deno.writeTextFile(
    join(cwd, file),
    insertOutput(src, open, close, code),
  );
  return { action: "added", file };
}

export function describeStandaloneResult(
  r: StandaloneResult,
): string | undefined {
  if (r.action === "ok") return undefined;
  const change = r.action === "created"
    ? `Created ${r.file} with output: "standalone"`
    : `Added output: "standalone" to ${r.file}`;
  return `${change} — Next.js backends deploy as a prebuilt bundle, so the ` +
    `build must produce .next/standalone.`;
}
