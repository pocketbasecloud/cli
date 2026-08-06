import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  envCandidates,
  envFileEntry,
  resolveEnvFile,
} from "../../../src/commands/deploy-helper.ts";
import { CliError } from "../../../src/errors.ts";
import type { PromptIO } from "../../../src/ui/prompt.ts";

function fakeIO(inputs: string[]): PromptIO {
  const q = [...inputs];
  return {
    read: () => Promise.resolve(q.shift() ?? null),
    write: () => {},
    isTTY: true,
  };
}

function seed(files: Record<string, string>): string {
  const root = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    Deno.mkdirSync(join(full, ".."), { recursive: true });
    Deno.writeTextFileSync(full, body);
  }
  return root;
}

const noop = () => {};
const base = { environment: "prod", skip: false, noInput: false };

Deno.test("nothing configured and no way to ask pushes nothing", async () => {
  // The heart of the change: a directory with a .env no longer has it pushed
  // just for existing. Under --no-input there is nobody to ask, so it is a
  // silent no-op rather than an error.
  const cwd = seed({ ".env": "A=1\n" });
  const d = await resolveEnvFile({ ...base, cwd, build: {}, noInput: true });
  assertEquals(d, {});
});

Deno.test("a configured envFile is read without asking", async () => {
  const cwd = seed({ ".env.prod": "A=1\nB=2\n", ".env": "LOCAL=1\n" });
  const d = await resolveEnvFile({
    ...base,
    cwd,
    build: { envFile: ".env.prod" },
    io: fakeIO([]), // any prompt here would throw on the empty queue
  });
  assertEquals(d.push?.name, ".env.prod");
  assertEquals(d.push?.vars, { A: "1", B: "2" });
  assertEquals(d.record, undefined); // already recorded
});

Deno.test('envFile "" is an answer: no push, no prompt', async () => {
  const cwd = seed({ ".env": "A=1\n", ".env.prod": "B=2\n" });
  const d = await resolveEnvFile({
    ...base,
    cwd,
    build: { envFile: "" },
    io: fakeIO([]),
  });
  assertEquals(d, {});
});

Deno.test("--env-file wins over the configured file and is recorded", async () => {
  const cwd = seed({ ".env.prod": "A=1\n", ".env.other": "B=2\n" });
  const d = await resolveEnvFile({
    ...base,
    cwd,
    build: { envFile: ".env.prod" },
    flag: ".env.other",
    io: fakeIO([]),
  });
  assertEquals(d.push?.name, ".env.other");
  assertEquals(d.record, ".env.other");
});

Deno.test("--skip-env resolves nothing at all", async () => {
  const cwd = seed({ ".env.prod": "A=1\n" });
  const d = await resolveEnvFile({
    ...base,
    cwd,
    build: { envFile: ".env.prod" },
    skip: true,
    io: fakeIO([]),
  });
  assertEquals(d, {});
});

Deno.test("a named file that is not on disk is fatal, from flag or from pb.json", async () => {
  const cwd = seed({ "main.ts": "x" });
  await assertRejects(
    () => resolveEnvFile({ ...base, cwd, build: {}, flag: ".env.prod" }),
    CliError,
    "Env file not found: .env.prod",
  );
  await assertRejects(
    () =>
      resolveEnvFile({
        ...base,
        cwd,
        build: { envFile: ".env.prod" },
        io: fakeIO([]),
      }),
    CliError,
    "Env file not found: .env.prod",
  );
});

Deno.test("the prompt offers the candidates and records the pick", async () => {
  const cwd = seed({ ".env": "A=1\n", ".env.prod": "B=2\n" });
  // 1) Don't push  2) .env.prod  3) .env  4) Enter a path…
  const d = await resolveEnvFile({
    ...base,
    cwd,
    build: {},
    io: fakeIO(["2"]),
  });
  assertEquals(d.push?.name, ".env.prod");
  assertEquals(d.push?.vars, { B: "2" });
  assertEquals(d.record, ".env.prod");
});

Deno.test('the prompt\'s "don\'t push" answer records "" so it is asked once', async () => {
  const cwd = seed({ ".env": "A=1\n" });
  const d = await resolveEnvFile({
    ...base,
    cwd,
    build: {},
    io: fakeIO(["1"]),
  });
  assertEquals(d.push, undefined);
  assertEquals(d.record, "");
});

Deno.test("the prompt's last entry takes a path the directory does not list", async () => {
  const cwd = seed({ ".env": "A=1\n", "config/prod.env": "C=3\n" });
  // 1) Don't push  2) .env  3) Enter a path…
  const d = await resolveEnvFile({
    ...base,
    cwd,
    build: {},
    io: fakeIO(["3", "config/prod.env"]),
  });
  assertEquals(d.push?.name, "config/prod.env");
  assertEquals(d.push?.vars, { C: "3" });
  assertEquals(d.record, "config/prod.env");
});

Deno.test("no dotenv candidates means no prompt at all", async () => {
  // Asking a question whose only honest answer is "no" would put a prompt in
  // front of the first deploy of every project that has no env vars.
  const cwd = seed({ "main.ts": "x", ".env.example": "A=\n" });
  const d = await resolveEnvFile({ ...base, cwd, build: {}, io: fakeIO([]) });
  assertEquals(d, {});
});

Deno.test("candidates rank the environment's own file first and drop templates", async () => {
  const cwd = seed({
    ".env": "",
    ".env.staging": "",
    ".env.prod": "",
    ".env.example": "",
    ".env.sample": "",
    ".env.template": "",
    "main.ts": "",
  });
  assertEquals(await envCandidates(cwd, "prod"), [
    ".env.prod",
    ".env",
    ".env.staging",
  ]);
  assertEquals(await envCandidates(cwd, "staging"), [
    ".env.staging",
    ".env",
    ".env.prod",
  ]);
});

Deno.test("envFileEntry writes the decision only when the environment has none", async () => {
  const cwd = seed({
    "pb.json": JSON.stringify({
      projectId: "p1",
      kind: "backends",
      environments: {
        prod: { id: "r1", name: "api", build: { envFile: ".env.prod" } },
        staging: { id: "r2", name: "api-stg" },
      },
    }),
  });

  // Insert-only: prod already has one, so --env-file stays a one-shot override.
  assertEquals(
    await envFileEntry(cwd, "prod", { record: ".env.other" }, noop),
    {},
  );
  // staging has none, so the decision is recorded.
  assertEquals(
    await envFileEntry(cwd, "staging", { record: ".env.staging" }, noop),
    { build: { envFile: ".env.staging" } },
  );
  // "no env file" is a decision too, and is recorded as such.
  assertEquals(
    await envFileEntry(cwd, "staging", { record: "" }, noop),
    { build: { envFile: "" } },
  );
  // Nothing decided, nothing written.
  assertEquals(await envFileEntry(cwd, "staging", {}, noop), {});
});
