import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertConfigured,
  boundIdsOf,
  chooseEnvironment,
  entryFor,
  findServerEnvironmentMember,
  resolveEnvironmentName,
} from "../../src/resolve/environment.ts";
import type { PreviewSummary } from "../../src/clients/previews.ts";
import { createMockCloudClient } from "../mocks/cloud.mock.ts";
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

Deno.test("--env wins over PBC_ENV and the file's default", () => {
  assertEquals(
    resolveEnvironmentName(TWO, {
      flag: "staging",
      env: { PBC_ENV: "preview" },
    }),
    { name: "staging", explicit: true, configured: true },
  );
});

Deno.test("PBC_ENV wins over the file's default", () => {
  assertEquals(
    resolveEnvironmentName(TWO, { env: { PBC_ENV: "staging" } }),
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

Deno.test("resolveEnvironmentName reads PBC_ENV from the process when unspecified", () => {
  Deno.env.set("PBC_ENV", "staging");
  try {
    assertEquals(resolveEnvironmentName(TWO).name, "staging");
  } finally {
    Deno.env.delete("PBC_ENV");
  }
});

Deno.test("an invalid name from PBC_ENV is rejected too", () => {
  Deno.env.set("PBC_ENV", " ");
  try {
    assertThrows(
      () => resolveEnvironmentName(TWO),
      CliError,
      "Invalid environment name",
    );
  } finally {
    Deno.env.delete("PBC_ENV");
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
  assertEquals(
    await chooseEnvironment(
      { name: "production", explicit: false, configured: true },
      TWO,
      { noInput: false, io: fakeIO(["staging"]) },
    ),
    { name: "production", explicit: false, configured: true },
  );
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

Deno.test("a pre-0.6.0 PB_ENV still selects the environment", () => {
  assertEquals(
    resolveEnvironmentName(TWO, { env: { PB_ENV: "staging" } }).name,
    "staging",
  );
  assertEquals(
    resolveEnvironmentName(TWO, {
      env: { PB_ENV: "staging", PBC_ENV: "production" },
    }).name,
    "production",
  );
});

async function serverEnvironments(
  previewsOf: (query: Record<string, string>) => PreviewSummary[],
) {
  const client = createMockCloudClient();
  const project = await client.createProject("app");
  const db = await client.createResource("pocketbases", {
    name: "db",
    project: project.id,
  });
  const web = await client.createResource("frontends", {
    name: "web",
    project: project.id,
  });
  const admin = await client.createResource("frontends", {
    name: "admin",
    project: project.id,
  });
  const webCopy = await client.createResource("frontends", {
    name: "web-staging",
    project: project.id,
  });
  await client.updateResource("frontends", webCopy.id, { previewOf: web.id });
  const adminCopy = await client.createResource("frontends", {
    name: "admin-staging",
    project: project.id,
  });
  await client.updateResource("frontends", adminCopy.id, {
    previewOf: admin.id,
  });
  client.ext = (path, body, opts) => {
    client.calls.ext.push([path, body ?? opts?.query]);
    return Promise.resolve(Response.json({
      success: true,
      data: { previews: previewsOf(opts?.query ?? {}) },
    }));
  };
  return { client, project, db, web, admin, webCopy, adminCopy };
}

function environment(
  name: string,
  members: PreviewSummary["members"],
): PreviewSummary {
  return {
    id: `prev-${name}`,
    name,
    status: "ready",
    statusMessage: "",
    lifetime: "permanent",
    expiresAt: "",
    data: "copy",
    crons: "off",
    created: "",
    members,
  };
}

function copyOf(
  kind: PreviewSummary["members"][number]["kind"],
  id: string,
  name: string,
  previewOf: string,
): PreviewSummary["members"][number] {
  return {
    id,
    kind,
    name,
    previewOf,
    baseUrl: `https://${id}.example.com`,
    status: "running",
    statusMessage: "",
  };
}

Deno.test("a server environment is found by name among the live website's own previews", async () => {
  let ids: Record<string, string> = {};
  const fx = await serverEnvironments((query) =>
    query.resourceId === ids.web && query.kind === "frontend"
      ? [environment("staging", [
        copyOf("frontend", ids.webCopy, "web-staging", ids.web),
      ])]
      : []
  );
  ids = { web: fx.web.id, webCopy: fx.webCopy.id };
  const found = await findServerEnvironmentMember(fx.client, {
    projectId: fx.project.id,
    kind: "frontends",
    name: "staging",
  });
  assertEquals(found?.id, fx.webCopy.id);
  assertEquals(
    await findServerEnvironmentMember(fx.client, {
      projectId: fx.project.id,
      kind: "frontends",
      name: "qa",
    }),
    null,
  );
});

Deno.test("when several live websites have the environment, the directory's live one wins", async () => {
  let ids: Record<string, string> = {};
  const fx = await serverEnvironments((query) =>
    query.resourceId === ids.web
      ? [environment("staging", [
        copyOf("frontend", ids.webCopy, "web-staging", ids.web),
      ])]
      : query.resourceId === ids.admin
      ? [environment("staging", [
        copyOf("frontend", ids.adminCopy, "admin-staging", ids.admin),
      ])]
      : []
  );
  ids = {
    web: fx.web.id,
    admin: fx.admin.id,
    webCopy: fx.webCopy.id,
    adminCopy: fx.adminCopy.id,
  };
  const found = await findServerEnvironmentMember(fx.client, {
    projectId: fx.project.id,
    kind: "frontends",
    name: "staging",
    liveIds: [fx.admin.id],
  });
  assertEquals(found?.id, fx.adminCopy.id);
  const err = await assertRejects(
    () =>
      findServerEnvironmentMember(fx.client, {
        projectId: fx.project.id,
        kind: "frontends",
        name: "staging",
      }),
    CliError,
  );
  assertEquals(err.code, "CONFLICT");
  assertEquals(err.hint, "pbc website preview ls");
});

Deno.test("only the live resources of the deploying kind are asked for their previews", async () => {
  const fx = await serverEnvironments(() => []);
  await findServerEnvironmentMember(fx.client, {
    projectId: fx.project.id,
    kind: "frontends",
    name: "staging",
  });
  assertEquals(
    fx.client.calls.ext.map(([, query]) => query),
    [
      { kind: "frontend", resourceId: fx.web.id },
      { kind: "frontend", resourceId: fx.admin.id },
    ],
  );
});

Deno.test("boundIdsOf lists the directory's bound ids of its own kind only", () => {
  assertEquals(boundIdsOf(TWO, "frontends"), ["fe1", "fe2"]);
  assertEquals(boundIdsOf(TWO, "backends"), []);
  assertEquals(boundIdsOf(null, "frontends"), []);
});
