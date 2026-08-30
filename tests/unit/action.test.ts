import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { VERSION } from "../../src/version.ts";
import {
  deployUrl,
  mask,
  PUBLIC_FIELDS,
  resolveKind,
  unwrapEnvelope,
} from "../../action/summarize.mjs";

const actionPath = join(
  import.meta.dirname!,
  "..",
  "..",
  "action",
  "action.yml",
);

function readAction(): string {
  return Deno.readTextFileSync(actionPath);
}

Deno.test("action.yml's cli-version default matches the CLI's own VERSION", () => {
  const text = readAction();
  const match = text.match(
    /cli-version:[\s\S]*?default:\s*"([^"]+)"/,
  );
  if (!match) {
    throw new Error(
      "Could not find inputs.cli-version.default in action.yml",
    );
  }
  assertEquals(match[1], VERSION);
});

Deno.test("action.yml declares the documented inputs and outputs", () => {
  const text = readAction();
  for (
    const input of [
      "token:",
      "kind:",
      "working-directory:",
      "cli-version:",
      "project:",
      "name:",
      "env:",
      "compute:",
      "location:",
      "skip-build:",
      "args:",
    ]
  ) {
    assertStringIncludes(text, input);
  }
  for (
    const output of ["url:", "id:", "name:", "status:", "kind:", "environment:"]
  ) {
    assertStringIncludes(text, output);
  }
});

Deno.test("action.yml runs as a composite action, not js or docker", () => {
  const text = readAction();
  assertStringIncludes(text, 'using: "composite"');
});

Deno.test("action.yml never prints the raw deploy record", () => {
  const text = readAction();
  assertEquals(/cat\s+"?\$\{?RUNNER_TEMP/.test(text), false);
});

Deno.test("action.yml redirects the deploy record, never pipes it", () => {
  const text = readAction();
  const deployLine = text.split("\n").find((l) =>
    l.includes('pbc "${argv[@]}"')
  );
  if (!deployLine) throw new Error("Could not find the deploy invocation");
  assertStringIncludes(deployLine, ">");
  assertEquals(deployLine.includes("|"), false);
});

const summarizePath = join(
  import.meta.dirname!,
  "..",
  "..",
  "action",
  "summarize.mjs",
);

Deno.test("mask emits add-mask for secret fields before anything else", () => {
  const lines: string[] = [];
  mask({
    adminUsername: "admin@example.com",
    adminPassword: "s3cret-pass",
    token: "tok_abcdef",
    name: "prod",
  }, (line) => lines.push(line));
  assertEquals(lines[0].startsWith("::add-mask::"), true);
  assertEquals(lines.includes("::add-mask::s3cret-pass"), true);
  assertEquals(lines.includes("::add-mask::admin@example.com"), true);
  assertEquals(lines.includes("::add-mask::tok_abcdef"), true);
  assertEquals(lines.some((l) => l.includes("prod")), false);
});

Deno.test("mask skips secret strings of length 3 or less", () => {
  const lines: string[] = [];
  mask({ adminPassword: "ab", token: "xyz" }, (line) => lines.push(line));
  assertEquals(lines, []);
});

Deno.test("mask walks nested objects and arrays", () => {
  const lines: string[] = [];
  mask({ nested: [{ password: "nested-secret" }] }, (line) => lines.push(line));
  assertEquals(lines, ["::add-mask::nested-secret"]);
});

Deno.test("resolveKind prefers an explicit kind over the record", () => {
  assertEquals(
    resolveKind("frontend", { runtime: "deno", baseUrl: "https://x" }),
    "frontend",
  );
  assertEquals(resolveKind("auto", { runtime: "deno" }), "backend");
  assertEquals(resolveKind("", { runtime: "deno" }), "backend");
});

Deno.test("resolveKind classifies a PocketBase, backend, and frontend record", () => {
  assertEquals(resolveKind("auto", { runtime: "deno" }), "backend");
  assertEquals(
    resolveKind("auto", { baseUrl: "https://x.pocketbasecloud.com" }),
    "pb",
  );
  assertEquals(resolveKind("auto", { domain: "site.example.com" }), "frontend");
});

Deno.test("deployUrl prefers baseUrl and refuses a missing address", () => {
  assertEquals(
    deployUrl({ baseUrl: "https://pb.example" }),
    "https://pb.example",
  );
  assertEquals(
    deployUrl({ domain: "web.example.com" }),
    "https://web.example.com",
  );
  assertEquals(deployUrl({}), "");
  assertEquals(deployUrl({ domain: "" }), "");
});

Deno.test("PUBLIC_FIELDS is the six-output whitelist minus url and kind", () => {
  assertEquals(PUBLIC_FIELDS, ["id", "name", "status", "environment"]);
});

Deno.test("unwrapEnvelope unwraps {ok, schemaVersion, data} and passes through anything else", () => {
  assertEquals(
    unwrapEnvelope({ ok: true, schemaVersion: 1, data: { id: "pb1" } }),
    { id: "pb1" },
  );
  assertEquals(unwrapEnvelope({ id: "pb1" }), { id: "pb1" });
  assertEquals(unwrapEnvelope({ ok: true, data: { id: "pb1" } }), {
    ok: true,
    data: { id: "pb1" },
  });
  assertEquals(unwrapEnvelope(null), null);
  assertEquals(unwrapEnvelope([1, 2]), [1, 2]);
});

async function runSummarize(
  record: unknown | string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; outputs: string; summary: string }> {
  const dir = Deno.makeTempDirSync();
  const recordPath = join(dir, "record.json");
  const outputPath = join(dir, "github-output");
  const summaryPath = join(dir, "summary");
  if (typeof record === "string") {
    Deno.writeTextFileSync(recordPath, record);
  } else {
    Deno.writeTextFileSync(recordPath, JSON.stringify(record));
  }
  const child = new Deno.Command("node", {
    args: [summarizePath, recordPath],
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await child.output();
  const text = new TextDecoder().decode(stdout);
  let outputs = "";
  let summary = "";
  try {
    outputs = Deno.readTextFileSync(outputPath);
  } catch { /* not written on failure */ }
  try {
    summary = Deno.readTextFileSync(summaryPath);
  } catch { /* not written on failure */ }
  return { code, stdout: text, outputs, summary };
}

Deno.test("summarize.mjs publishes six outputs and masks PocketBase credentials first", async () => {
  const { code, stdout, outputs, summary } = await runSummarize({
    id: "pb1",
    name: "api",
    status: "running",
    environment: "production",
    baseUrl: "https://pb.example.com",
    adminUsername: "admin@example.com",
    adminPassword: "s3cret-pass",
    extra: "should-not-appear",
  });
  assertEquals(code, 0);
  const lines = stdout.trim().split("\n");
  assertEquals(lines[0], "::add-mask::admin@example.com");
  assertEquals(lines.includes("::add-mask::s3cret-pass"), true);
  assertEquals(stdout.includes("should-not-appear"), false);
  const unmasked = stdout.split("\n").filter((l) =>
    !l.startsWith("::add-mask::")
  ).join("\n");
  assertEquals(unmasked.includes("s3cret-pass"), false);
  assertStringIncludes(outputs, "url=https://pb.example.com\n");
  assertStringIncludes(outputs, "kind=pb\n");
  assertStringIncludes(outputs, "id=pb1\n");
  assertStringIncludes(outputs, "name=api\n");
  assertStringIncludes(outputs, "status=running\n");
  assertStringIncludes(outputs, "environment=production\n");
  assertEquals(outputs.includes("adminPassword"), false);
  assertEquals(outputs.includes("extra"), false);
  assertStringIncludes(summary, "https://pb.example.com");
});

Deno.test("summarize.mjs unwraps the {ok, schemaVersion, data} envelope pbc --json now writes", async () => {
  const { code, outputs, summary } = await runSummarize({
    ok: true,
    schemaVersion: 1,
    data: {
      id: "pb1",
      name: "api",
      status: "running",
      environment: "production",
      baseUrl: "https://pb.example.com",
      adminUsername: "admin@example.com",
      adminPassword: "s3cret-pass",
    },
  });
  assertEquals(code, 0);
  assertStringIncludes(outputs, "url=https://pb.example.com\n");
  assertStringIncludes(outputs, "id=pb1\n");
  assertEquals(outputs.includes("adminPassword"), false);
  assertStringIncludes(summary, "https://pb.example.com");
});

Deno.test("summarize.mjs labels a frontend from domain and a backend from runtime", async () => {
  const fe = await runSummarize({
    id: "fe1",
    name: "web",
    status: "running",
    domain: "web.example.com",
  });
  assertEquals(fe.code, 0);
  assertStringIncludes(fe.outputs, "kind=frontend\n");
  assertStringIncludes(fe.outputs, "url=https://web.example.com\n");

  const be = await runSummarize({
    id: "be1",
    name: "api",
    status: "running",
    domain: "api.example.com",
    runtime: "deno",
  });
  assertEquals(be.code, 0);
  assertStringIncludes(be.outputs, "kind=backend\n");
});

Deno.test("summarize.mjs exits 1 on a missing URL without echoing the record", async () => {
  const { code, stdout, outputs } = await runSummarize({
    id: "pb1",
    adminPassword: "s3cret-pass",
    adminUsername: "admin@example.com",
  });
  assertEquals(code, 1);
  assertStringIncludes(stdout, "::error::The deploy reported no URL.");
  assertEquals(stdout.includes("{"), false);
  assertEquals(outputs, "");
});

Deno.test("summarize.mjs exits 1 on an unreadable file and deletes it", async () => {
  const dir = Deno.makeTempDirSync();
  const recordPath = join(dir, "record.json");
  Deno.writeTextFileSync(recordPath, "not-json {");
  const child = new Deno.Command("node", {
    args: [summarizePath, recordPath],
    env: {
      PATH: Deno.env.get("PATH") ?? "",
    },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await child.output();
  const text = new TextDecoder().decode(stdout);
  assertEquals(code, 1);
  assertStringIncludes(text, "::error::Could not read the deploy record");
  assertEquals(text.includes("not-json"), false);
  assertEquals(text.includes("{"), false);
  let gone = false;
  try {
    Deno.statSync(recordPath);
  } catch {
    gone = true;
  }
  assertEquals(gone, true);
});

export function stepScript(name: string): string {
  const lines = readAction().split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start < 0) throw new Error(`No step named ${name}`);
  const runAt = lines.findIndex((l, i) => i > start && l.trim() === "run: |");
  if (runAt < 0) throw new Error(`Step ${name} has no block run:`);
  const indent = lines[runAt].length - lines[runAt].trimStart().length + 2;
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

async function runDeployStep(
  env: Record<string, string>,
): Promise<{ code: number; argv: string[]; stderr: string }> {
  const dir = Deno.makeTempDirSync();
  const script = `pbc() { printf '%s\\n' "$@"; }\n${stepScript("Deploy")}`;
  const child = new Deno.Command("bash", {
    args: ["-c", script],
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      RUNNER_TEMP: dir,
      PBC_KIND: "auto",
      PBC_PROJECT: "",
      PBC_NAME: "",
      PBC_ENVIRONMENT: "",
      PBC_COMPUTE: "",
      PBC_LOCATION: "",
      PBC_SKIP_BUILD: "false",
      PBC_EXTRA_ARGS: "",
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await child.output();
  let argv: string[] = [];
  try {
    argv = Deno.readTextFileSync(join(dir, "pbc-deploy.json")).split("\n")
      .filter(
        (l) => l !== "",
      );
  } catch { /* the step failed before running pbc */ }
  return { code, argv, stderr: new TextDecoder().decode(stderr) };
}

Deno.test("the Deploy step keeps a quoted argument in one piece", async () => {
  const { code, argv } = await runDeployStep({
    PBC_EXTRA_ARGS: '--name "My Site" --force',
  });
  assertEquals(code, 0);
  assertEquals(argv, [
    "cloud",
    "deploy",
    "--name",
    "My Site",
    "--force",
    "--no-input",
    "--json",
  ]);
});

Deno.test("the Deploy step refuses an args string it cannot split", async () => {
  const { code, argv } = await runDeployStep({
    PBC_EXTRA_ARGS: '--name "My Site',
  });
  assertEquals(code === 0, false);
  assertEquals(argv, []);
});

Deno.test("summarize.mjs still runs when reached through a symlink", async () => {
  const dir = Deno.makeTempDirSync();
  const link = join(dir, "summarize.mjs");
  Deno.symlinkSync(summarizePath, link);
  const recordPath = join(dir, "record.json");
  const outputPath = join(dir, "github-output");
  Deno.writeTextFileSync(
    recordPath,
    JSON.stringify({ id: "abc", name: "site", domain: "site.example.com" }),
  );
  const { code } = await new Deno.Command("node", {
    args: [link, recordPath],
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(code, 0);
  assertStringIncludes(
    Deno.readTextFileSync(outputPath),
    "url=https://site.example.com",
  );
});
