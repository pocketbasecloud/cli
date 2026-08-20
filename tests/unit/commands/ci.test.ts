import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type GitRunner,
  makeCiCommands,
  renderWorkflow,
} from "../../../src/commands/ci.ts";
import { readOwnPbJson } from "../../../src/config.ts";
import { VERSION } from "../../../src/version.ts";
import { CliError } from "../../../src/errors.ts";

function seed(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

const flags = { json: true, yes: true, noInput: true, interactive: false };

/** A stand-in `git`: answers a fixed script instead of touching a real repo. */
type GitScript = {
  root?: string | null;
  /** What `origin/HEAD` resolves to — the repo's default branch. */
  defaultBranch?: string | null;
  /** What is checked out right now. */
  branch?: string | null;
  tracked?: string[];
  ignored?: string[];
};
function fakeGit(script: GitScript): GitRunner {
  return (args) => {
    const sub = args[0];
    if (sub === "rev-parse") {
      return Promise.resolve(
        script.root
          ? { code: 0, stdout: script.root }
          : { code: 1, stdout: "" },
      );
    }
    if (sub === "symbolic-ref") {
      const wantsDefault = args.includes("refs/remotes/origin/HEAD");
      const value = wantsDefault ? script.defaultBranch : script.branch;
      return Promise.resolve(
        value ? { code: 0, stdout: value } : { code: 1, stdout: "" },
      );
    }
    if (sub === "ls-files") {
      const path = args[args.length - 1];
      const hit = (script.tracked ?? []).some((f) => path.endsWith(f));
      return Promise.resolve({ code: hit ? 0 : 1, stdout: "" });
    }
    if (sub === "check-ignore") {
      const path = args[args.length - 1];
      const hit = (script.ignored ?? []).some((f) => path.endsWith(f));
      return Promise.resolve({ code: hit ? 0 : 1, stdout: "" });
    }
    return Promise.resolve({ code: 1, stdout: "" });
  };
}

function run(
  cwd: string,
  args: string[],
  git: GitRunner,
  raw: Record<string, unknown> = {},
) {
  return makeCiCommands({ cwd: () => cwd, git })["cloud ci init"]({
    args,
    flags,
    raw,
  });
}

function captureLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => console.log = original };
}

// --- renderWorkflow: pure, no disk or git -----------------------------------

Deno.test("renderWorkflow at the repo root omits working-directory and paths", () => {
  const yaml = renderWorkflow({
    kind: "pocketbases",
    workingDirectory: ".",
    branch: "main",
    version: "0.4.0",
    workflowPath: ".github/workflows/deploy.yml",
  });
  assertStringIncludes(yaml, "name: Deploy\n");
  assertStringIncludes(yaml, "branches: [main]");
  assertStringIncludes(yaml, "uses: pocketbasecloud/cli/action@v0.4.0");
  assertStringIncludes(yaml, "kind: pb");
  assertStringIncludes(yaml, "group: deploy-production");
  assertEquals(yaml.includes("working-directory:"), false);
  assertEquals(yaml.includes("paths:"), false);
});

Deno.test("renderWorkflow in a subdirectory scopes the job, paths, and concurrency group", () => {
  const yaml = renderWorkflow({
    kind: "frontends",
    workingDirectory: "web",
    branch: "main",
    version: "0.4.0",
    workflowPath: ".github/workflows/deploy-web.yml",
  });
  assertStringIncludes(yaml, "name: Deploy web\n");
  assertStringIncludes(
    yaml,
    'paths: ["web/**", ".github/workflows/deploy-web.yml"]',
  );
  assertStringIncludes(yaml, "working-directory: web");
  assertStringIncludes(yaml, "kind: frontend");
  assertStringIncludes(yaml, "group: deploy-web-production");
});

Deno.test("renderWorkflow slugs a nested directory so the filename and group stay unique", () => {
  const yaml = renderWorkflow({
    kind: "frontends",
    workingDirectory: "apps/web",
    branch: "main",
    version: "0.4.0",
    workflowPath: ".github/workflows/deploy-apps-web.yml",
  });
  assertStringIncludes(yaml, "name: Deploy apps-web\n");
  assertStringIncludes(
    yaml,
    'paths: ["apps/web/**", ".github/workflows/deploy-apps-web.yml"]',
  );
  assertStringIncludes(yaml, "working-directory: apps/web");
  assertStringIncludes(yaml, "group: deploy-apps-web-production");
});

Deno.test("renderWorkflow names each kind's action input correctly", () => {
  for (
    const [kind, word] of [
      ["pocketbases", "pb"],
      ["frontends", "frontend"],
      ["backends", "backend"],
    ] as const
  ) {
    const yaml = renderWorkflow({
      kind,
      workingDirectory: ".",
      branch: "main",
      version: "0.4.0",
      workflowPath: ".github/workflows/deploy.yml",
    });
    assertStringIncludes(yaml, `kind: ${word}`);
  }
});

Deno.test("renderWorkflow writes an explicit environment only when given one", () => {
  const withEnv = renderWorkflow({
    kind: "backends",
    workingDirectory: "api",
    branch: "main",
    environment: "staging",
    version: "0.4.0",
    workflowPath: ".github/workflows/deploy-api.yml",
  });
  assertStringIncludes(withEnv, "env: staging");
  assertStringIncludes(withEnv, "group: deploy-api-staging");

  const withoutEnv = renderWorkflow({
    kind: "backends",
    workingDirectory: "api",
    branch: "main",
    version: "0.4.0",
    workflowPath: ".github/workflows/deploy-api.yml",
  });
  assertEquals(withoutEnv.includes("env:"), false);
});

Deno.test("renderWorkflow pins the action to the given version", () => {
  const yaml = renderWorkflow({
    kind: "pocketbases",
    workingDirectory: ".",
    branch: "main",
    version: "9.9.9",
    workflowPath: ".github/workflows/deploy.yml",
  });
  assertStringIncludes(yaml, "pocketbasecloud/cli/action@v9.9.9");
});

// --- the handler: disk + git ------------------------------------------------

Deno.test("cloud ci init refuses when there is no pb.json", async () => {
  const cwd = Deno.makeTempDirSync();
  await assertRejects(
    () => run(cwd, [], fakeGit({ root: cwd })),
    CliError,
  );
});

Deno.test("cloud ci init writes the workflow and pins the running CLI's version", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "frontends",
      environments: { production: { id: "f1", name: "web" } },
    }),
  });
  const code = await run(cwd, [], fakeGit({ root: cwd, branch: "main" }));
  assertEquals(code, 0);
  const written = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  assertStringIncludes(written, `pocketbasecloud/cli/action@v${VERSION}`);
  assertStringIncludes(written, "kind: frontend");
});

Deno.test("cloud ci init falls back to main with no current branch", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
  });
  const code = await run(cwd, [], fakeGit({ root: cwd, branch: null }));
  assertEquals(code, 0);
  const written = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  assertStringIncludes(written, "branches: [main]");
});

Deno.test("cloud ci init refuses an unknown kind argument", async () => {
  const cwd = seed({ "pb.json": JSON.stringify({ projectId: "p1" }) });
  await assertRejects(
    () => run(cwd, ["nonsense"], fakeGit({ root: cwd })),
    CliError,
  );
});

Deno.test("cloud ci init errors when the directory is bound to no kind at all", async () => {
  const cwd = seed({ "pb.json": JSON.stringify({ projectId: "p1" }) });
  await assertRejects(
    () => run(cwd, [], fakeGit({ root: cwd })),
    CliError,
  );
});

Deno.test("cloud ci init refuses outside a git repository", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
  });
  await assertRejects(
    () => run(cwd, [], fakeGit({ root: null })),
    CliError,
  );
});

Deno.test("cloud ci init leaves an existing workflow alone without --force", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
    ".github/workflows/deploy.yml": "# hand-written\n",
  });
  const { lines, restore } = captureLog();
  let code: number;
  try {
    code = await run(cwd, [], fakeGit({ root: cwd, branch: "main" }), {});
  } finally {
    restore();
  }
  assertEquals(code, 0);
  const stillThere = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  assertEquals(stillThere, "# hand-written\n");
  assertEquals(JSON.parse(lines[0]).written, false);
});

Deno.test("cloud ci init --force overwrites an existing workflow", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
    ".github/workflows/deploy.yml": "# hand-written\n",
  });
  const code = await run(cwd, [], fakeGit({ root: cwd, branch: "main" }), {
    force: true,
  });
  assertEquals(code, 0);
  const now = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  assertStringIncludes(now, "pocketbasecloud/cli/action");
});

Deno.test("cloud ci init warns when pb.json is not tracked by git", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
  });
  const code = await run(
    cwd,
    [],
    fakeGit({ root: cwd, branch: "main", tracked: [] }),
  );
  assertEquals(code, 0);
  // captured via --json, asserted in the next test; here just confirm no crash.
});

Deno.test("cloud ci init's --json warnings carry the untracked-pb.json case", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
  });
  const { lines, restore } = captureLog();
  let code: number;
  try {
    code = await run(
      cwd,
      [],
      fakeGit({ root: cwd, branch: "main", tracked: [] }),
    );
  } finally {
    restore();
  }
  assertEquals(code, 0);
  const out = JSON.parse(lines[0]);
  assertEquals(
    out.warnings.some((w: string) => w.includes("not tracked by git")),
    true,
  );
});

Deno.test("cloud ci init warns when the configured env file is git-ignored", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "backends",
      build: { envFile: ".env" },
    }),
  });
  const { lines, restore } = captureLog();
  let code: number;
  try {
    code = await run(
      cwd,
      [],
      fakeGit({
        root: cwd,
        branch: "main",
        tracked: ["pb.json"],
        ignored: [".env"],
      }),
    );
  } finally {
    restore();
  }
  assertEquals(code, 0);
  const out = JSON.parse(lines[0]);
  assertEquals(
    out.warnings.some((w: string) => w.includes("Env file not found")),
    true,
  );
});

Deno.test("cloud ci init warns when the configured env file is untracked", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "backends",
      build: { envFile: ".env" },
    }),
  });
  const { lines, restore } = captureLog();
  let code: number;
  try {
    code = await run(
      cwd,
      [],
      fakeGit({
        root: cwd,
        branch: "main",
        tracked: ["pb.json"],
      }),
    );
  } finally {
    restore();
  }
  assertEquals(code, 0);
  const out = JSON.parse(lines[0]);
  assertEquals(
    out.warnings.some((w: string) => w.includes("Env file not found")),
    true,
  );
});

Deno.test("cloud ci init is quiet when the configured env file is tracked", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "backends",
      build: { envFile: ".env" },
    }),
  });
  const { lines, restore } = captureLog();
  let code: number;
  try {
    code = await run(
      cwd,
      [],
      fakeGit({
        root: cwd,
        branch: "main",
        tracked: ["pb.json", ".env"],
      }),
    );
  } finally {
    restore();
  }
  assertEquals(code, 0);
  const out = JSON.parse(lines[0]);
  assertEquals(
    out.warnings.some((w: string) => w.includes("Env file not found")),
    false,
  );
});

Deno.test("cloud ci init warns that PocketBase deploys carry admin credentials", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "pocketbases" }),
  });
  const { lines, restore } = captureLog();
  let code: number;
  try {
    code = await run(
      cwd,
      [],
      fakeGit({ root: cwd, branch: "main", tracked: ["pb.json"] }),
    );
  } finally {
    restore();
  }
  assertEquals(code, 0);
  const out = JSON.parse(lines[0]);
  assertEquals(
    out.warnings.some((w: string) => w.includes("admin credentials")),
    true,
  );
});

Deno.test("cloud ci init respects an explicit --out path", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
  });
  const code = await run(
    cwd,
    [],
    fakeGit({ root: cwd, branch: "main" }),
    { out: "custom.yml" },
  );
  assertEquals(code, 0);
  const written = await Deno.readTextFile(join(cwd, "custom.yml"));
  assertStringIncludes(written, "pocketbasecloud/cli/action");
});

Deno.test("cloud ci init respects an explicit --branch", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
  });
  const code = await run(
    cwd,
    [],
    fakeGit({ root: cwd, branch: "main" }),
    { branch: "release" },
  );
  assertEquals(code, 0);
  const written = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  assertStringIncludes(written, "branches: [release]");
});

Deno.test("cloud ci init leaves the file's own default environment implicit", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "backends",
      defaultEnvironment: "production",
      environments: { production: { id: "b1", name: "api" } },
    }),
  });
  const code = await run(cwd, [], fakeGit({ root: cwd, branch: "main" }));
  assertEquals(code, 0);
  const written = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  // resolveEnvironmentName treats the file's own default as non-explicit —
  // the workflow leaves --env unset so the CLI's own default resolution
  // keeps following it.
  assertEquals(written.includes("env:"), false);
});

Deno.test("cloud ci init writes an explicit environment when --env is passed", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "backends",
      environments: {
        production: { id: "b1", name: "api" },
        staging: { id: "b2", name: "api-staging" },
      },
    }),
  });
  const code = await run(
    cwd,
    [],
    fakeGit({ root: cwd, branch: "main" }),
    { env: "staging" },
  );
  assertEquals(code, 0);
  const written = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  assertStringIncludes(written, "env: staging");
});

Deno.test("cloud ci init accepts the pb/frontend/backend kind aliases", async () => {
  const cwd = seed({ "pb.json": JSON.stringify({ projectId: "p1" }) });
  const code = await run(cwd, ["pb"], fakeGit({ root: cwd, branch: "main" }));
  assertEquals(code, 0);
  const written = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  assertStringIncludes(written, "kind: pb");
  // pb.json itself is untouched by ci init — only the workflow file is written.
  assertEquals((await readOwnPbJson(cwd)).kind, undefined);
});

// --- regressions -----------------------------------------------------------

Deno.test("renderWorkflow's paths filter names the workflow's real path", () => {
  const yaml = renderWorkflow({
    kind: "frontends",
    workingDirectory: "web",
    branch: "main",
    version: "0.5.0",
    workflowPath: ".github/workflows/custom-name.yml",
  });
  // Deriving this from the directory meant a --out-renamed workflow never
  // re-triggered on edits to itself.
  assertStringIncludes(
    yaml,
    'paths: ["web/**", ".github/workflows/custom-name.yml"]',
  );
});

Deno.test("cloud ci init asks git about THIS directory's pb.json, not the root's", async () => {
  const root = seed({
    "web/pb.json": JSON.stringify({ projectId: "p1", kind: "frontends" }),
  });
  const cwd = join(root, "web");
  const asked: string[] = [];
  const git: GitRunner = (args) => {
    if (args[0] === "rev-parse") {
      return Promise.resolve({ code: 0, stdout: root });
    }
    if (args[0] === "symbolic-ref") {
      return Promise.resolve({ code: 0, stdout: "main" });
    }
    if (args[0] === "ls-files") {
      asked.push(args[args.length - 1]);
      // web/pb.json IS committed.
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return Promise.resolve({ code: 1, stdout: "" });
  };
  const { lines, restore } = captureLog();
  let code: number;
  try {
    code = await makeCiCommands({ cwd: () => cwd, git })["cloud ci init"]({
      args: [],
      flags,
      raw: {},
    });
  } finally {
    restore();
  }
  assertEquals(code, 0);
  // The pathspec must point at web/pb.json — a bare "pb.json" would resolve
  // against the repo root and warn about a file that was never the subject.
  assertEquals(asked.length, 1);
  assertStringIncludes(asked[0], join("web", "pb.json"));
  const out = JSON.parse(lines[0]);
  assertEquals(
    out.warnings.some((w: string) => w.includes("not tracked by git")),
    false,
  );
});

Deno.test("cloud ci init honours an absolute --out instead of nesting it under cwd", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
  });
  const target = join(Deno.makeTempDirSync(), "elsewhere.yml");
  const code = await run(
    cwd,
    [],
    fakeGit({ root: cwd, branch: "main" }),
    { out: target },
  );
  assertEquals(code, 0);
  // Written where asked, not at <cwd>/<abs path>.
  assertStringIncludes(
    await Deno.readTextFile(target),
    "pocketbasecloud/cli/action",
  );
});

Deno.test("cloud ci init ignores an ambient PB_ENV when generating the workflow", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "backends",
      environments: {
        production: { id: "b1", name: "api" },
        staging: { id: "b2", name: "api-staging" },
      },
      defaultEnvironment: "production",
    }),
  });
  const previous = Deno.env.get("PB_ENV");
  Deno.env.set("PB_ENV", "staging");
  try {
    const code = await run(cwd, [], fakeGit({ root: cwd, branch: "main" }));
    assertEquals(code, 0);
    const written = await Deno.readTextFile(
      join(cwd, ".github", "workflows", "deploy.yml"),
    );
    // A shell variable must not get committed into CI config — only --env does.
    assertEquals(written.includes("env: staging"), false);
  } finally {
    if (previous === undefined) Deno.env.delete("PB_ENV");
    else Deno.env.set("PB_ENV", previous);
  }
});

Deno.test("cloud ci init's generated header does not promise a prompt", () => {
  const yaml = renderWorkflow({
    kind: "backends",
    workingDirectory: ".",
    branch: "main",
    version: "0.5.0",
    workflowPath: ".github/workflows/deploy.yml",
  });
  // It refuses and points at --force; it never asks.
  assertEquals(yaml.includes("asks"), false);
  assertStringIncludes(yaml, "--force");
});

Deno.test("cloud ci init wires the checked-out branch, not origin/HEAD", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
  });
  const code = await run(
    cwd,
    [],
    fakeGit({ root: cwd, defaultBranch: "main", branch: "my-feature" }),
  );
  assertEquals(code, 0);
  const written = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  assertStringIncludes(written, "branches: [my-feature]");
});

Deno.test("cloud ci init lets --branch override the checked-out branch", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
  });
  const code = await run(
    cwd,
    [],
    fakeGit({ root: cwd, defaultBranch: "main", branch: "my-feature" }),
    { branch: "release" },
  );
  assertEquals(code, 0);
  const written = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  assertStringIncludes(written, "branches: [release]");
});

Deno.test("cloud ci init falls back to origin/HEAD when HEAD is detached", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({ projectId: "p1", kind: "backends" }),
  });
  const { lines, restore } = captureLog();
  let code: number;
  try {
    code = await run(
      cwd,
      [],
      fakeGit({ root: cwd, defaultBranch: "main", branch: null }),
    );
  } finally {
    restore();
  }
  assertEquals(code, 0);
  const written = await Deno.readTextFile(
    join(cwd, ".github", "workflows", "deploy.yml"),
  );
  assertStringIncludes(written, "branches: [main]");
  const out = JSON.parse(lines[0]);
  assertEquals(
    out.warnings.some((w: string) => w.includes("--branch")),
    true,
  );
});

Deno.test("cloud ci init writes a unique workflow file for a nested directory", async () => {
  const root = seed({
    "apps/web/pb.json": JSON.stringify({ projectId: "p1", kind: "frontends" }),
  });
  const cwd = join(root, "apps", "web");
  const code = await run(cwd, [], fakeGit({ root, branch: "main" }));
  assertEquals(code, 0);
  const written = await Deno.readTextFile(
    join(root, ".github", "workflows", "deploy-apps-web.yml"),
  );
  assertStringIncludes(written, "working-directory: apps/web");
  assertStringIncludes(written, "group: deploy-apps-web-production");
});

// --- YAML quoting -----------------------------------------------------------
//
// Every value below reaches the file as a YAML scalar. A branch name is free
// text (`--branch` is unvalidated, and git itself allows `,`), so a bare
// interpolation lets the value re-read as something else — silently, in the
// comma case, which yields a valid workflow that simply never fires.

Deno.test("renderWorkflow quotes a branch a bare YAML sequence would split", () => {
  const yaml = renderWorkflow({
    kind: "frontends",
    workingDirectory: ".",
    branch: "feat,wip",
    version: "0.4.0",
    workflowPath: ".github/workflows/deploy.yml",
  });
  assertStringIncludes(yaml, 'branches: ["feat,wip"]');
});

Deno.test("renderWorkflow quotes values carrying a YAML indicator", () => {
  const yaml = renderWorkflow({
    kind: "frontends",
    workingDirectory: "apps/we:b",
    branch: "release: v1",
    environment: "sta ging",
    version: "0.4.0",
    workflowPath: ".github/workflows/deploy-apps-we-b.yml",
  });
  assertStringIncludes(yaml, 'branches: ["release: v1"]');
  assertStringIncludes(yaml, 'working-directory: "apps/we:b"');
  assertStringIncludes(yaml, 'name: "Deploy apps-we:b"');
  assertStringIncludes(yaml, 'group: "deploy-apps-we:b-sta ging"');
});

Deno.test("renderWorkflow escapes a quote rather than closing the scalar", () => {
  const yaml = renderWorkflow({
    kind: "frontends",
    workingDirectory: ".",
    branch: 'we"ird',
    version: "0.4.0",
    workflowPath: ".github/workflows/deploy.yml",
  });
  assertStringIncludes(yaml, 'branches: ["we\\"ird"]');
});
