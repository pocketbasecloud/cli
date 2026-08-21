import { join } from "@std/path";
import { CliError } from "../errors.ts";

/**
 * Making a Next.js project produce `.next/standalone`.
 *
 * The platform never runs `next build` (it exhausts memory on a shared host),
 * so a Next.js backend is deployed as a prebuilt standalone bundle. That only
 * exists when the project's own config asks for it, and a project that has
 * never been deployed here has no reason to. Left alone, the deploy builds
 * successfully and *then* dies at packaging — the slowest possible way to
 * learn about a one-line config change.
 *
 * So the CLI writes the line itself, before the build, and says so. This is the
 * same bargain as the inferred `build` block in pbc.json: the tool edits the
 * project, the edit is idempotent, and it shows up in a diff.
 */

/** Resolution order matches Next's own; the first one present is the config. */
const CONFIG_NAMES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.cjs",
  "next.config.mts",
  "next.config.cts",
];

export type StandaloneResult =
  /** The config already builds standalone; nothing was written. */
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

/**
 * `src` with comments and regex literals blanked (`code`), and a second copy
 * with string *contents* blanked too (`mask`). Both keep the original length
 * and line breaks, so an index into either is an index into `src`.
 *
 * Two views because the two questions need different things: finding the
 * `output` key must still see `"output"` as a quoted key, while brace matching
 * must not count a `{` that lives inside a string or a template literal.
 */
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
  // Last significant character, which is what distinguishes a regex literal
  // from division: `/` after a value divides, after an operator or `(` opens.
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
      // The quotes themselves survive in both views: `output: "…"` stays
      // recognisable, and the real value is read back out of `src`.
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

/** An `output:` key, quoted or not, that is not a property *access*. */
const OUTPUT_KEY = /(?:^|[^\w$.])(["']?)output\1\s*:\s*/g;

/** The braces a config object spans, so only its own keys are read. */
export type Scope = { mask: string; open: number; close: number };

/** True when `index` sits directly inside the scope's object, not nested in it. */
function isOwnProperty(s: Scope, index: number): boolean {
  if (index < s.open || index > s.close) return false;
  let depth = 0;
  for (let i = s.open; i < index; i++) {
    if (s.mask[i] === "{") depth++;
    else if (s.mask[i] === "}") depth--;
  }
  return depth === 1;
}

/**
 * What the config says about `output`: the literal string it is set to,
 * "computed" when it is set to something this cannot read (a variable, a
 * ternary, `process.env.…`), or null when the key is absent.
 *
 * Scoped to the config object's *own* keys when the object was located, since
 * `output` is a common key elsewhere — a webpack config spread inside
 * `webpack()`, a plugin's options object — and refusing a deploy over one of
 * those would be a false alarm. Unscoped it errs the other way, so a config
 * shape this cannot edit still gets diagnosed as a static export rather than
 * as an unparseable file.
 */
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

/** Index of the `{` that opens the exported config object, or -1. */
export function findConfigObject(mask: string): number {
  const assignment = /(?:module\.exports|export\s+default)\s*=?\s*/;
  const m = assignment.exec(mask);
  if (!m) return -1;
  return resolveObject(mask, m.index + m[0].length, 0);
}

/**
 * From the position of a config *expression*, find the object literal behind
 * it. Handles the four shapes people write: the object inline, a variable
 * holding it, a plugin wrapper around either (`withMDX({…})`,
 * `withMDX(nextConfig)`), and any nesting of the two.
 *
 * Returns -1 for anything else — notably the function form
 * (`module.exports = (phase) => ({…})`), where "the config object" is not a
 * literal in the file at all and guessing would corrupt it.
 */
function resolveObject(mask: string, from: number, depth: number): number {
  if (depth > 5) return -1;
  let i = from;
  while (i < mask.length && /\s/.test(mask[i])) i++;
  if (mask[i] === "{") return i;

  const ident = /^[A-Za-z_$][\w$]*/.exec(mask.slice(i));
  if (!ident) return -1;
  let j = i + ident[0].length;
  while (j < mask.length && /\s/.test(mask[j])) j++;

  // `withPlugin(<config>)`. In a chain — `withBundleAnalyzer({ enabled })(<config>)`,
  // which is how several plugins are configured — only the *last* call receives
  // the Next config; the earlier arguments are the plugin's own options, and
  // writing `output` into those would be silently wrong.
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

  // A bare identifier: follow it to its declaration.
  const decl = new RegExp(
    `(?:const|let|var)\\s+${ident[0]}\\s*(?::[^=;]+)?=\\s*`,
  ).exec(mask);
  if (!decl) return -1;
  return resolveObject(mask, decl.index + decl[0].length, depth + 1);
}

/** Index of the delimiter closing the one at `open`, or -1. */
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

/**
 * Whichever quote the file's *code* already prefers, so the edit reads like the
 * file. Comments do not get a vote: the JSDoc `@type {import('next')…}` header
 * every Next config carries would otherwise decide it single-handedly.
 */
function quoteStyle(code: string): string {
  const single = (code.match(/'/g) ?? []).length;
  const double = (code.match(/"/g) ?? []).length;
  return single > double ? "'" : '"';
}

/**
 * `src` with `output: "standalone"` added as the config object's *last*
 * property. Last, not first, so it wins over any key this could not read —
 * a later duplicate is the one JavaScript keeps.
 */
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

/** True when package.json marks the directory as ESM. */
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

/**
 * What the directory's Next config says its build produces, or null when the
 * directory has no Next config at all.
 *
 * Shared by the deploy path below and by kind detection, which asks the same
 * question for a different reason: `output: "export"` is the one setting that
 * makes a Next.js directory a *frontend* rather than a backend.
 */
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

/**
 * Guarantees that a `next build` in `cwd` produces `.next/standalone`, writing
 * the config change when it does not. Idempotent: a config that already builds
 * standalone is left untouched.
 *
 * Throws (exit 2) rather than guessing when the config states a different
 * `output`, computes it, or is written in a form with no object literal to
 * edit — in each case the user's own intent is the thing at stake.
 */
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
        `line to deploy it as a Next.js backend.`,
      2,
    );
  }
  if (output !== null) {
    throw new CliError(
      output === "computed"
        ? `${file} computes its "output" value, so the CLI cannot tell what ` +
          `the build produces. Set output: "standalone" there and deploy again.`
        : `${file} sets output: "${output}". Next.js backends must be built ` +
          `with output: "standalone" — change it and deploy again.`,
      2,
    );
  }

  if (close === -1) {
    throw new CliError(
      `Could not add output: "standalone" to ${file} automatically — its ` +
        `config is not a plain object literal. Add output: "standalone" to ` +
        `the config it exports and deploy again.`,
      2,
    );
  }
  await Deno.writeTextFile(
    join(cwd, file),
    insertOutput(src, open, close, code),
  );
  return { action: "added", file };
}

/** The line the deploy prints for a result, or none when nothing changed. */
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
