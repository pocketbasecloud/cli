// Reads a `pb ... deploy --json` record and turns it into step outputs and a
// job summary — without ever putting the record itself in the log.
//
// The masking has to come first and has to be generous. A PocketBase deploy's
// record carries `adminUsername`/`adminPassword`, GitHub only hides values it
// has been told are secret, and a generated password is not one it can guess.
// Anything printed after this point is safe; anything printed before it is not.
import {
  appendFileSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Field names whose values must never reach the log verbatim. */
export const SECRET_KEY = /pass(word)?|secret|token|credential|adminUsername/i;
/** The only fields allowed out of the record. */
export const PUBLIC_FIELDS = ["id", "name", "status", "environment"];

/**
 * Emit `::add-mask::` for every secret-ish value anywhere in the record.
 * Walks the whole object rather than a fixed field list: a field added to the
 * platform's record should be redacted by default, not on the next release of
 * this action.
 */
export function mask(value, emit = (line) => console.log(line)) {
  if (Array.isArray(value)) {
    for (const item of value) mask(item, emit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && typeof child === "string" && child.length > 3) {
      emit(`::add-mask::${child}`);
    } else {
      mask(child, emit);
    }
  }
}

/** `auto` is what the caller passed, not what was deployed — ask the record. */
export function resolveKind(input, rec) {
  if (input && input !== "auto") return input;
  if (typeof rec.runtime === "string" && rec.runtime) return "backend";
  if (typeof rec.baseUrl === "string" && rec.baseUrl) return "pb";
  return "frontend";
}

export function deployUrl(record) {
  if (typeof record.baseUrl === "string" && record.baseUrl) {
    return record.baseUrl;
  }
  if (typeof record.domain === "string" && record.domain) {
    return `https://${record.domain}`;
  }
  return "";
}

export function str(value) {
  return value === undefined || value === null ? "" : String(value);
}

export function main(argv = process.argv, env = process.env) {
  const file = argv[2];
  if (!file) {
    fail("summarize.mjs needs the path of the deploy record.");
  }

  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // The record is unreadable, so nothing in it has been masked. Remove it
    // rather than leave an unmasked file for a later step to pick up.
    try {
      unlinkSync(file);
    } catch { /* already gone */ }
    fail(
      "Could not read the deploy record. The deploy may have written " +
        "something other than JSON.",
    );
  }

  mask(record);

  const url = deployUrl(record);
  // `.domain` is absent until the platform records one. Without this guard the
  // URL would be the cheerful nonsense "https://" and the job would stay green.
  if (!url) {
    fail("The deploy reported no URL.");
  }

  const kind = resolveKind(env.PB_KIND, record);
  setOutput(env, "url", url);
  setOutput(env, "kind", kind);
  for (const field of PUBLIC_FIELDS) setOutput(env, field, str(record[field]));

  const label = str(record.name) || kind;
  write(env.GITHUB_STEP_SUMMARY, `🚀 Deployed ${label} to ${url}\n`);
  console.log(`Deployed ${label} to ${url}`);
}

/**
 * One line per output. Values are single-line by construction (ids, names,
 * statuses, a URL), and a stray newline would let a value forge another
 * output, so it is stripped rather than escaped.
 */
function setOutput(env, name, value) {
  write(env.GITHUB_OUTPUT, `${name}=${value.replace(/[\r\n]+/g, " ")}\n`);
}

function write(path, line) {
  if (path) appendFileSync(path, line);
}

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

/**
 * True when this file is what node was asked to run. Node resolves symlinks
 * when it loads an ES module but leaves `argv[1]` exactly as typed, so
 * comparing the two verbatim made the whole step a silent no-op — exit 0, no
 * outputs, no summary — anywhere GITHUB_ACTION_PATH crossed a link.
 */
function isEntrypoint() {
  const arg = process.argv[1];
  if (!arg) return false;
  const here = fileURLToPath(import.meta.url);
  const there = resolve(arg);
  if (here === there) return true;
  try {
    return here === realpathSync(there);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main();
}
