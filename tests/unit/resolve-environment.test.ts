import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertConfigured,
  chooseEnvironment,
  entryFor,
  resolveEnvironmentName,
} from "../../src/resolve/environment.ts";
import type { PromptIO } from "../../src/ui/prompt.ts";
import { CliError } from "../../src/errors.ts";
import type { LinkFile } from "../../src/config.ts";

const TWO: Partial<LinkFile> = {
  projectId: "p1",
  kind: "frontends",
  defaultEnvironment: "production",
  environments: {
    production: { id: "fe1", name: "web" },
    staging: { id: "fe2", name: "web-staging" },
  },
};

Deno.test("--env wins over PB_ENV and the file's default", () => {
  assertEquals(
    resolveEnvironmentName(TWO, {
      flag: "staging",
      env: { PB_ENV: "preview" },
    }),
    { name: "staging", explicit: true, configured: true },
  );
});

Deno.test("PB_ENV wins over the file's default", () => {
  assertEquals(
    resolveEnvironmentName(TWO, { env: { PB_ENV: "staging" } }),
    { name: "staging", explicit: true, configured: true },
  );
});

Deno.test("defaultEnvironment is used when nothing names one", () => {
  assertEquals(resolveEnvironmentName(TWO, { env: {} }), {
    name: "production",
    explicit: false,
    configured: true,
  });
});

Deno.test("a sole environment is the answer without a declared default", () => {
  assertEquals(
    resolveEnvironmentName({
      environments: { staging: { id: "fe2", name: "web-staging" } },
    }, { env: {} }),
    { name: "staging", explicit: false, configured: true },
  );
});

Deno.test("no environments at all answers production, the name a deploy records", () => {
  assertEquals(resolveEnvironmentName(null, { env: {} }), {
    name: "production",
    explicit: false,
    configured: false,
  });
});

Deno.test("several environments and no default is an error, not a guess", () => {
  const err = assertThrows(
    () =>
      resolveEnvironmentName({
        environments: {
          production: { id: "fe1", name: "web" },
          staging: { id: "fe2", name: "s" },
        },
      }, { env: {} }),
    CliError,
  );
  assertEquals(err.exitCode, 2);
  assertEquals(
    err.message,
    "Multiple environments configured (production, staging). Pass --env <name>.",
  );
});

Deno.test("an explicitly named environment is validated", () => {
  assertThrows(
    () => resolveEnvironmentName(TWO, { flag: "two words", env: {} }),
    CliError,
    'Invalid environment name "two words".',
  );
});

Deno.test("assertConfigured rejects an explicit name the file lacks", () => {
  const choice = resolveEnvironmentName(TWO, { flag: "preview", env: {} });
  assertThrows(
    () => assertConfigured(choice, TWO),
    CliError,
    'Unknown environment "preview". Configured: production, staging.',
  );
});

Deno.test("assertConfigured is silent when the file configures no environments", () => {
  // A repo-wide PB_ENV must not break a directory that was never linked;
  // --name/--id still decide there, exactly as before environments existed.
  const choice = resolveEnvironmentName(null, { flag: "staging", env: {} });
  assertConfigured(choice, null);
});

Deno.test("assertConfigured is silent for a name the file chose itself", () => {
  assertConfigured(resolveEnvironmentName(TWO, { env: {} }), TWO);
});

Deno.test("entryFor ignores a file bound to a different kind", () => {
  const choice = resolveEnvironmentName(TWO, { env: {} });
  assertEquals(entryFor(TWO, "frontends", choice), { id: "fe1", name: "web" });
  assertEquals(entryFor(TWO, "backends", choice), undefined);
});

Deno.test("resolveEnvironmentName reads PB_ENV from the process when unspecified", () => {
  // The commands call it without an env map, so the process variable must reach
  // it — the path CI relies on.
  Deno.env.set("PB_ENV", "staging");
  try {
    assertEquals(resolveEnvironmentName(TWO).name, "staging");
  } finally {
    Deno.env.delete("PB_ENV");
  }
});

Deno.test("an invalid name from PB_ENV is rejected too", () => {
  Deno.env.set("PB_ENV", " ");
  try {
    assertThrows(
      () => resolveEnvironmentName(TWO),
      CliError,
      "Invalid environment name",
    );
  } finally {
    Deno.env.delete("PB_ENV");
  }
});

function fakeIO(inputs: string[]): PromptIO {
  const q = [...inputs];
  return {
    read: () => Promise.resolve(q.shift() ?? null),
    write: () => {},
    isTTY: true,
  };
}

const NONE = { name: "production", explicit: false, configured: false };

Deno.test("chooseEnvironment asks when the directory names none", async () => {
  const got = await chooseEnvironment(NONE, null, {
    noInput: false,
    io: fakeIO(["staging"]),
  });
  assertEquals(got, { name: "staging", explicit: false, configured: false });
});

Deno.test("chooseEnvironment takes an empty answer as the default", async () => {
  const got = await chooseEnvironment(NONE, {}, {
    noInput: false,
    io: fakeIO([""]),
  });
  assertEquals(got, NONE);
});

Deno.test("chooseEnvironment does not ask when the file already answers", async () => {
  // Configured environments...
  assertEquals(
    await chooseEnvironment(
      { name: "production", explicit: false, configured: true },
      TWO,
      { noInput: false, io: fakeIO(["staging"]) },
    ),
    { name: "production", explicit: false, configured: true },
  );
  // ...or just a recorded default, as `init` writes.
  assertEquals(
    (await chooseEnvironment(NONE, { defaultEnvironment: "qa" }, {
      noInput: false,
      io: fakeIO(["staging"]),
    })).name,
    "production",
  );
});

Deno.test("chooseEnvironment leaves an explicit --env alone", async () => {
  const explicit = { name: "preview", explicit: true, configured: false };
  assertEquals(
    await chooseEnvironment(explicit, null, {
      noInput: false,
      io: fakeIO(["staging"]),
    }),
    explicit,
  );
});

Deno.test("chooseEnvironment keeps the unattended default", async () => {
  assertEquals(
    await chooseEnvironment(NONE, null, { noInput: true, io: fakeIO(["x"]) }),
    NONE,
  );
});

Deno.test("chooseEnvironment rejects an unusable name", async () => {
  await assertRejects(
    () =>
      chooseEnvironment(NONE, null, {
        noInput: false,
        io: fakeIO(["two words"]),
      }),
    CliError,
    "Invalid environment name",
  );
});
