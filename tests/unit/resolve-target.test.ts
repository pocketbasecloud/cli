import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  parseQualifiedName,
  resolveResourceTarget,
} from "../../src/resolve/target.ts";
import { createMockCloudClient } from "../mocks/cloud.mock.ts";
import { KINDS } from "../../src/kinds.ts";
import { CliError } from "../../src/errors.ts";
import type { Config } from "../../src/config.ts";
import type { PromptIO } from "../../src/ui/prompt.ts";

function ttyIO(answer: string): PromptIO {
  return {
    read: () => Promise.resolve(answer),
    write: () => {},
    isTTY: true,
  };
}

async function fixture(
  seed: {
    projects: [string, string][];
    resources: { name: string; project: string; kind?: "pocketbases" }[];
    link?: Record<string, unknown>;
  },
) {
  const client = createMockCloudClient();
  const byName = new Map<string, string>();
  for (const [, name] of seed.projects) {
    const p = await client.createProject(name);
    byName.set(name, p.id);
  }
  const resolveP = (token: string) => byName.get(token) ?? token;
  for (const r of seed.resources) {
    await client.createResource("pocketbases", {
      name: r.name,
      project: resolveP(r.project),
    });
  }
  const cwd = Deno.makeTempDirSync();
  if (seed.link) {
    Deno.writeTextFileSync(
      join(cwd, "pbc.json"),
      JSON.stringify(seed.link, null, 2),
    );
  }
  return { client, cwd, projectId: resolveP };
}

Deno.test("parseQualifiedName splits on the first slash only", () => {
  assertEquals(parseQualifiedName("api-db"), { name: "api-db" });
  assertEquals(parseQualifiedName("acme/api-db"), {
    project: "acme",
    name: "api-db",
  });
  assertEquals(parseQualifiedName("acme/api/db"), {
    project: "acme",
    name: "api/db",
  });
});

Deno.test("a bare name resolves across every project when it is unique", async () => {
  const { client, cwd } = await fixture({
    projects: [["p1", "acme"], ["p2", "other"]],
    resources: [
      { name: "api-db", project: "acme" },
      { name: "sessions", project: "other" },
    ],
  });
  const { resource } = await resolveResourceTarget({
    client,
    spec: KINDS.pocketbases,
    cwd,
    name: "api-db",
    explicit: true,
    noInput: true,
  });
  assertEquals(resource.name, "api-db");
});

Deno.test("a name held by two projects lists the qualified forms", async () => {
  const { client, cwd } = await fixture({
    projects: [["p1", "acme-prod"], ["p2", "acme-staging"]],
    resources: [
      { name: "api-db", project: "acme-prod" },
      { name: "api-db", project: "acme-staging" },
    ],
  });
  const err = await assertRejects(
    () =>
      resolveResourceTarget({
        client,
        spec: KINDS.pocketbases,
        cwd,
        name: "api-db",
        explicit: true,
        noInput: true,
      }),
    CliError,
  );
  assertEquals(err.code, "USAGE");
  assertEquals(err.message.includes("acme-prod/api-db"), true);
  assertEquals(err.message.includes("acme-staging/api-db"), true);
});

Deno.test("a qualified project/name resolves without ambiguity", async () => {
  const { client, cwd } = await fixture({
    projects: [["p1", "acme-prod"], ["p2", "acme-staging"]],
    resources: [
      { name: "api-db", project: "acme-prod" },
      { name: "api-db", project: "acme-staging" },
    ],
  });
  const { resource } = await resolveResourceTarget({
    client,
    spec: KINDS.pocketbases,
    cwd,
    name: "acme-staging/api-db",
    explicit: true,
    noInput: true,
  });
  assertEquals(resource.project !== undefined, true);
});

Deno.test("a name that matches nothing is NOT_FOUND with the near match", async () => {
  const { client, cwd } = await fixture({
    projects: [["p1", "acme"]],
    resources: [{ name: "api-prod", project: "acme" }],
  });
  const err = await assertRejects(
    () =>
      resolveResourceTarget({
        client,
        spec: KINDS.pocketbases,
        cwd,
        name: "api-prd",
        explicit: true,
        noInput: true,
      }),
    CliError,
  );
  assertEquals(err.code, "NOT_FOUND");
  assertEquals(err.message.includes("api-prod"), true);
});

Deno.test("a pbc.json binding resolves with no prompt and announces on stderr", async () => {
  const { client, cwd, projectId } = await fixture({
    projects: [["p1", "acme"]],
    resources: [{ name: "api-db", project: "acme" }],
  });
  const list = await client.listResources("pocketbases");
  Deno.writeTextFileSync(
    join(cwd, "pbc.json"),
    JSON.stringify({
      projectId: projectId("acme"),
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: list[0].id, name: "api-db" } },
    }),
  );
  const notices: string[] = [];
  const { resource } = await resolveResourceTarget({
    client,
    spec: KINDS.pocketbases,
    cwd,
    explicit: true,
    noInput: true,
    log: (m: string) => notices.push(m),
  });
  assertEquals(resource.name, "api-db");
  assertEquals(notices.some((n) => n.includes("api-db")), true);
});

Deno.test("no name, no binding, non-interactive names the ways out", async () => {
  const { client, cwd } = await fixture({
    projects: [["p1", "acme"]],
    resources: [
      { name: "one", project: "acme" },
      { name: "two", project: "acme" },
    ],
  });
  const err = await assertRejects(
    () =>
      resolveResourceTarget({
        client,
        spec: KINDS.pocketbases,
        cwd,
        explicit: true,
        noInput: true,
      }),
    CliError,
  );
  assertEquals(err.code, "NO_TARGET");
  assertEquals(err.message.includes("pbc pocketbase ls"), true);
});

Deno.test("one candidate auto-selects only when the command is not explicit", async () => {
  const seed = {
    projects: [["p1", "acme"]] as [string, string][],
    resources: [{ name: "only", project: "acme" }],
  };

  const a = await fixture(seed);
  const relaxed = await resolveResourceTarget({
    client: a.client,
    spec: KINDS.pocketbases,
    cwd: a.cwd,
    explicit: false,
    noInput: true,
  });
  assertEquals(relaxed.resource.name, "only");

  const b = await fixture(seed);
  await assertRejects(
    () =>
      resolveResourceTarget({
        client: b.client,
        spec: KINDS.pocketbases,
        cwd: b.cwd,
        explicit: true,
        noInput: true,
      }),
    CliError,
  );
});

Deno.test("no name on a TTY opens a picker", async () => {
  const { client, cwd } = await fixture({
    projects: [["p1", "acme"]],
    resources: [
      { name: "one", project: "acme" },
      { name: "two", project: "acme" },
    ],
  });
  const { resource } = await resolveResourceTarget({
    client,
    spec: KINDS.pocketbases,
    cwd,
    explicit: true,
    noInput: false,
    io: ttyIO("2"),
  });
  assertEquals(resource.name, "two");
});

Deno.test("an unknown --id is NOT_FOUND", async () => {
  const { client, cwd } = await fixture({
    projects: [["p1", "acme"]],
    resources: [{ name: "api-db", project: "acme" }],
  });
  const err = await assertRejects(
    () =>
      resolveResourceTarget({
        client,
        spec: KINDS.pocketbases,
        cwd,
        id: "does-not-exist",
        explicit: true,
        noInput: true,
      }),
    CliError,
  );
  assertEquals(err.code, "NOT_FOUND");
});

Deno.test("--project narrows the candidates a bare name is matched against", async () => {
  const { client, cwd } = await fixture({
    projects: [["p1", "acme-prod"], ["p2", "acme-staging"]],
    resources: [
      { name: "api-db", project: "acme-prod" },
      { name: "api-db", project: "acme-staging" },
    ],
  });
  const { resource } = await resolveResourceTarget({
    client,
    spec: KINDS.pocketbases,
    cwd,
    name: "api-db",
    projectFilter: "acme-prod",
    explicit: true,
    noInput: true,
  });
  assertEquals(resource.project !== undefined, true);
  assertEquals(
    (await client.listProjects()).find((p) => p.id === resource.project)?.name,
    "acme-prod",
  );
});

Deno.test("config.currentProject scopes a bare name to that project", async () => {
  const { client, cwd, projectId } = await fixture({
    projects: [["p1", "alpha"], ["p2", "beta"]],
    resources: [
      { name: "api", project: "alpha" },
      { name: "api", project: "beta" },
    ],
  });
  const { resource } = await resolveResourceTarget({
    client,
    spec: KINDS.pocketbases,
    cwd,
    name: "api",
    config: { currentProject: projectId("alpha") } as Config,
    explicit: true,
    noInput: true,
  });
  assertEquals(
    (await client.listProjects()).find((p) => p.id === resource.project)?.name,
    "alpha",
  );
});

Deno.test("a bare name never resolves to a resource outside the current project", async () => {
  const { client, cwd, projectId } = await fixture({
    projects: [["p1", "alpha"], ["p2", "beta"]],
    resources: [{ name: "api", project: "beta" }],
  });
  const err = await assertRejects(
    () =>
      resolveResourceTarget({
        client,
        spec: KINDS.pocketbases,
        cwd,
        name: "api",
        config: { currentProject: projectId("alpha") } as Config,
        explicit: true,
        noInput: true,
      }),
    CliError,
  );
  assertEquals(err.code, "NOT_FOUND");
});

Deno.test("no name never auto-selects a resource outside the current project", async () => {
  const { client, cwd, projectId } = await fixture({
    projects: [["p1", "alpha"], ["p2", "beta"]],
    resources: [{ name: "only", project: "beta" }],
  });
  const err = await assertRejects(
    () =>
      resolveResourceTarget({
        client,
        spec: KINDS.pocketbases,
        cwd,
        config: { currentProject: projectId("alpha") } as Config,
        explicit: false,
        noInput: true,
      }),
    CliError,
  );
  assertEquals(err.code, "NOT_FOUND");
});

Deno.test("an empty --project filter names the project, not a missing binding", async () => {
  const { client, cwd } = await fixture({
    projects: [["p1", "alpha"], ["p2", "beta"]],
    resources: [
      { name: "one", project: "beta" },
      { name: "two", project: "beta" },
    ],
  });
  const err = await assertRejects(
    () =>
      resolveResourceTarget({
        client,
        spec: KINDS.pocketbases,
        cwd,
        projectFilter: "alpha",
        explicit: true,
        noInput: true,
      }),
    CliError,
  );
  assertEquals(err.code, "NOT_FOUND");
  assertEquals(err.message.includes('project "alpha"'), true);
  assertEquals(err.message.includes("pbc.json binding"), false);
});

Deno.test("a stale binding is NOT_FOUND with the recreate hint", async () => {
  const { client, cwd, projectId } = await fixture({
    projects: [["p1", "alpha"]],
    resources: [{ name: "one", project: "alpha" }],
  });
  Deno.writeTextFileSync(
    join(cwd, "pbc.json"),
    JSON.stringify({
      projectId: projectId("alpha"),
      kind: "pocketbases",
      defaultEnvironment: "production",
      environments: { production: { id: "gone", name: "api-db" } },
    }),
  );
  const err = await assertRejects(
    () =>
      resolveResourceTarget({
        client,
        spec: KINDS.pocketbases,
        cwd,
        explicit: true,
        noInput: true,
      }),
    CliError,
  );
  assertEquals(err.code, "NOT_FOUND");
  assertEquals(err.message.includes("no longer exists"), true);
});
