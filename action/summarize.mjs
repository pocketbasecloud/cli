import {
  appendFileSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SECRET_KEY = /pass(word)?|secret|token|credential|adminUsername/i;
export const PUBLIC_FIELDS = ["id", "name", "status", "environment"];

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

export function unwrapEnvelope(parsed) {
  if (
    parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    typeof parsed.ok === "boolean" && parsed.schemaVersion === 1
  ) {
    return parsed.data;
  }
  return parsed;
}

export function main(argv = process.argv, env = process.env) {
  const file = argv[2];
  if (!file) {
    fail("summarize.mjs needs the path of the deploy record.");
  }

  let record;
  try {
    record = unwrapEnvelope(JSON.parse(readFileSync(file, "utf8")));
  } catch {
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
