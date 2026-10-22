import { assertEquals, assertRejects } from "@std/assert";
import { CliError } from "../../../src/errors.ts";
import { createMockDeployFetch } from "../../mocks/deployments.mock.ts";
import {
  deployedBy,
  makeResourceCommands,
} from "../../../src/commands/resource.ts";
import { ALL_KINDS, KINDS } from "../../../src/kinds.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { repositoryLine } from "../../../src/clients/repo-link.ts";

function deps(
  client = createMockCloudClient(),
  currentProject = "",
): CloudCmdDeps {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
    currentProject,
  };
  const cwd = Deno.makeTempDirSync();
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => cwd,
  };
}

const flags = (over: Record<string, unknown> = {}) => ({
  json: true,
  yes: true,
  noInput: true,
  interactive: false,
  ...over,
});

Deno.test("every kind gets ls, info and rm", () => {
  for (const spec of ALL_KINDS) {
    const cmds = makeResourceCommands(deps(), spec);
    for (const verb of ["ls", "info", "rm"]) {
      const key = `${spec.noun} ${verb}`;
      assertEquals(typeof cmds[key]?.run, "function", `${key} is missing`);
    }
  }
});

Deno.test("ls lists only the kind it was built for", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("pocketbases", { name: "db", project: p.id });
  await client.createResource("frontends", { name: "site", project: p.id });
  const lines: string[] = [];
  const original = console.log;
  console.log = (m: string) => lines.push(m);
  try {
    const cmds = makeResourceCommands(deps(client, p.id), KINDS.frontends);
    assertEquals(
      await cmds["frontend ls"].run({}, {
        args: [],
        flags: flags({ project: p.id }),
      }),
      0,
    );
  } finally {
    console.log = original;
  }
  const rows = JSON.parse(lines[lines.length - 1]).data as { name: string }[];
  assertEquals(rows.map((r) => r.name), ["site"]);
});

Deno.test("rm marks the resource deleted through the kind's own collection", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const be = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  const cmds = makeResourceCommands(deps(client, p.id), KINDS.backends);
  const code = await cmds["backend rm"].run({ name: "api" }, {
    args: [],
    flags: flags({ project: p.id }),
  });
  assertEquals(code, 0);
  assertEquals(client.calls.updateResource[0], [
    "backends",
    be.id,
    { status: "deleted" },
  ]);
});

Deno.test("info under --json still prints the whole record", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db",
    project: p.id,
  });
  const lines: string[] = [];
  const original = console.log;
  console.log = (m: string) => lines.push(m);
  try {
    const cmds = makeResourceCommands(deps(client, p.id), KINDS.pocketbases);
    await cmds["pocketbase info"].run({ name: "db" }, {
      args: [],
      flags: flags({ project: p.id }),
    });
  } finally {
    console.log = original;
  }
  assertEquals(JSON.parse(lines[lines.length - 1]).data.id, pb.id);
});

Deno.test("every kind that declares domains gets all four verbs", () => {
  for (const spec of ALL_KINDS) {
    const cmds = makeResourceCommands(deps(), spec);
    for (const verb of ["add", "verify", "remove", "status"]) {
      const key = `${spec.noun} domain ${verb}`;
      assertEquals(
        typeof cmds[key]?.run,
        spec.domains ? "function" : "undefined",
        `${key} does not match the table`,
      );
    }
  }
});

Deno.test("each domain verb posts the kind's own id field to its own route", async () => {
  for (const spec of ALL_KINDS.filter((k) => k.domains)) {
    const client = createMockCloudClient();
    const p = await client.createProject("app");
    const r = await client.createResource(spec.kind, {
      name: "thing",
      project: p.id,
    });
    const cmds = makeResourceCommands(deps(client, p.id), spec);
    for (const verb of ["add", "verify", "remove"]) {
      const code = await cmds[`${spec.noun} domain ${verb}`].run(
        { name: "thing" },
        { args: ["example.com"], flags: flags({ project: p.id }) },
      );
      assertEquals(code, 0);
    }
    assertEquals(
      client.calls.ext.map(([path]) => path),
      [
        `/api/${spec.kind}/custom-domain/add`,
        `/api/${spec.kind}/custom-domain/verify`,
        `/api/${spec.kind}/custom-domain/remove`,
      ],
    );
    for (const [, body] of client.calls.ext) {
      assertEquals((body as Record<string, string>)[spec.idField], r.id);
      assertEquals(
        (body as Record<string, string>).custom_domain,
        "example.com",
      );
    }
  }
});

Deno.test("domain status sends no domain and reports the platform's answer", async () => {
  const client = createMockCloudClient({
    ext: (path, body) => {
      (client.calls.ext as [string, unknown][]).push([path, body]);
      return Promise.resolve(
        new Response(
          JSON.stringify({ success: true, data: { reachable: true } }),
          { status: 200 },
        ),
      );
    },
  });
  const p = await client.createProject("app");
  const be = await client.createResource("backends", {
    name: "api",
    project: p.id,
  });
  const lines: string[] = [];
  const original = console.log;
  console.log = (m: string) => lines.push(m);
  try {
    const cmds = makeResourceCommands(deps(client, p.id), KINDS.backends);
    assertEquals(
      await cmds["backend domain status"].run({ name: "api" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
      0,
    );
  } finally {
    console.log = original;
  }
  assertEquals(client.calls.ext[0][0], "/api/backends/custom-domain/status");
  assertEquals(client.calls.ext[0][1], { backend_id: be.id });
  assertEquals(JSON.parse(lines[lines.length - 1]).data.data.reachable, true);
});

type Row = {
  id: string;
  resourceId: string;
  status: string;
  created: string;
  gitSha?: string;
  metadata?: { rollbackOf?: string };
};

async function rollbackSetup(
  rows: (resourceId: string) => Row[],
  repository?: Record<string, unknown>,
) {
  const posted: unknown[] = [];
  const deploy = createMockDeployFetch();
  const client = createMockCloudClient({
    pbApi: (path) => {
      const all = rows(site.id);
      if (path.endsWith("/records")) {
        return Promise.resolve(Response.json({ items: all }));
      }
      const id = decodeURIComponent(path.split("/").pop()!);
      const row = all.find((d) => d.id === id) ??
        { id, resourceId: "other", status: "success", created: "" };
      return Promise.resolve(Response.json(row));
    },
    ext: (path, body) => {
      posted.push([path, body]);
      return Promise.resolve(
        Response.json({
          success: true,
          data: {
            deploymentId: "dep_1",
            ...(repository ? { repository } : {}),
          },
        }),
      );
    },
  });
  const p = await client.createProject("app");
  const site = await client.createResource("frontends", {
    name: "site",
    project: p.id,
  });
  const lines: string[] = [];
  const cmds = makeResourceCommands(
    { ...deps(client, p.id), fetch: deploy.fetchFn },
    KINDS.frontends,
  );
  const run = async (
    key: string,
    input: Record<string, unknown>,
  ): Promise<{ code: number; data: unknown }> => {
    const original = console.log;
    const originalError = console.error;
    console.log = (m: string) => lines.push(m);
    console.error = () => {};
    try {
      const code = await cmds[key].run({ name: "site", ...input }, {
        args: [],
        flags: flags({ project: p.id }),
      });
      return { code, data: JSON.parse(lines[lines.length - 1]).data };
    } finally {
      console.log = original;
      console.error = originalError;
    }
  };
  return { run, posted, deploy, site };
}

const history = (resourceId: string): Row[] => [
  { id: "d4", resourceId, status: "failed", created: "2026-10-19 10:00" },
  { id: "d3", resourceId, status: "success", created: "2026-10-18 10:00" },
  { id: "d2", resourceId, status: "failed", created: "2026-10-17 10:00" },
  {
    id: "d1",
    resourceId,
    status: "success",
    created: "2026-10-16 10:00",
    gitSha: "abcdef1234",
  },
];

Deno.test("every kind gets deployments and rollback", () => {
  for (const spec of ALL_KINDS) {
    const cmds = makeResourceCommands(deps(), spec);
    for (const verb of ["deployments", "rollback"]) {
      assertEquals(typeof cmds[`${spec.noun} ${verb}`]?.run, "function");
    }
  }
});

Deno.test("deployedBy names you, a teammate, the commit author or GitHub", () => {
  const row = { id: "d", resourceId: "r", status: "success", created: "" };
  assertEquals(deployedBy({ ...row, requestedBy: "u1" }, "u1"), "you");
  assertEquals(deployedBy({ ...row, requestedBy: "u2" }, "u1"), "a teammate");
  assertEquals(
    deployedBy({ ...row, gitSha: "abc", gitAuthor: "octocat" }, "u1"),
    "octocat",
  );
  assertEquals(deployedBy({ ...row, gitSha: "abc" }, "u1"), "GitHub");
});

Deno.test("deployments marks the live deployment", async () => {
  const { run } = await rollbackSetup(history);
  const { data } = await run("frontend deployments", {});
  assertEquals(
    (data as { id: string; live: boolean }[]).map((d) => [d.id, d.live]),
    [["d4", false], ["d3", true], ["d2", false], ["d1", false]],
  );
});

Deno.test("rollback without --to goes back to the success before the live one", async () => {
  const { run, posted } = await rollbackSetup(history);
  const { code, data } = await run("frontend rollback", {});
  assertEquals(code, 0);
  assertEquals(posted, [["/api/deployments/rollback", { deploymentId: "d1" }]]);
  assertEquals(data, { deploymentId: "dep_1", rollbackOf: "d1" });
});

Deno.test("rollback --push-to-git reports the commit that put the old source back", async () => {
  const repository = {
    status: "committed",
    repo: "acme/web",
    branch: "main",
    sha: "f00d1234",
  };
  const { run, posted } = await rollbackSetup(history, repository);
  const { data } = await run("frontend rollback", { "push-to-git": true });
  assertEquals(posted, [["/api/deployments/rollback", {
    deploymentId: "d1",
    pushToGit: true,
  }]]);
  assertEquals(data, { deploymentId: "dep_1", rollbackOf: "d1", repository });
});

Deno.test("repositoryLine says where the rollback went, or why the next push replaces it", () => {
  assertEquals(repositoryLine(undefined, "rollback"), null);
  assertEquals(
    repositoryLine(
      { status: "committed", repo: "a/b", branch: "main", sha: "f00d1234" },
      "rollback",
    ),
    "Committed the rollback to a/b (main) as f00d123.",
  );
  assertEquals(
    repositoryLine({
      status: "pullRequest",
      repo: "a/b",
      url: "https://github.com/a/b/pull/2",
      reason: "conflict",
      paths: [],
    }, "rollback"),
    "Opened a pull request for the rollback because a/b has commits that are not deployed yet: https://github.com/a/b/pull/2. Merge it to keep the rollback; a push before then replaces it.",
  );
  assertEquals(
    repositoryLine(
      { status: "failed", repo: "a/b", error: "gone" },
      "rollback",
    ),
    "Not committed to a/b: gone. The next push there will replace the rollback.",
  );
});

Deno.test("rollback refuses a deployment of another resource", async () => {
  const { run, posted } = await rollbackSetup(history);
  const error = await assertRejects(
    () => run("frontend rollback", { to: "elsewhere" }),
    CliError,
  );
  assertEquals(error.code, "INVALID_VALUE");
  assertEquals(posted, []);
});

Deno.test("rollback with nothing earlier says so", async () => {
  const { run } = await rollbackSetup((resourceId) => [
    { id: "d1", resourceId, status: "success", created: "" },
  ]);
  const error = await assertRejects(
    () => run("frontend rollback", {}),
    CliError,
  );
  assertEquals(error.code, "NOT_FOUND");
});

Deno.test("rollback to the live deployment changes nothing", async () => {
  const { run, posted } = await rollbackSetup(history);
  const { data } = await run("frontend rollback", { to: "d3" });
  assertEquals(posted, []);
  assertEquals(data, { deploymentId: null, rollbackOf: "d3" });
});

Deno.test("a failed rollback surfaces the platform's reason", async () => {
  const { run, deploy } = await rollbackSetup(history);
  deploy.setStatus("failed", "Server is unreachable");
  const error = await assertRejects(
    () => run("frontend rollback", { to: "d1" }),
    CliError,
  );
  assertEquals(error.code, "PLATFORM_ERROR");
  assertEquals(error.message, "Server is unreachable");
});

Deno.test("access commands exist exactly for the kinds the platform can make private", () => {
  for (const spec of ALL_KINDS) {
    const cmds = makeResourceCommands(deps(), spec);
    for (const verb of ["status", "private", "public", "add", "remove"]) {
      const key = `${spec.noun} access ${verb}`;
      assertEquals(
        typeof cmds[key]?.run,
        spec.access ? "function" : "undefined",
        `${key} does not match the table`,
      );
    }
  }
});

Deno.test("access verbs post the whole setting, keeping what the verb does not change", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const site = await client.createResource("frontends", {
    name: "site",
    project: p.id,
  });
  await client.updateResource("frontends", site.id, {
    access: "public",
    accessEmails: ["alice@example.com"],
  });
  const cmds = makeResourceCommands(deps(client, p.id), KINDS.frontends);
  const run = (verb: string, args: string[]) =>
    cmds[`frontend access ${verb}`].run({ name: "site" }, {
      args,
      flags: flags({ project: p.id }),
    });

  assertEquals(await run("private", []), 0);
  assertEquals(await run("add", ["Bob@Example.com,@team.dev"]), 0);
  assertEquals(await run("remove", ["alice@example.com"]), 0);
  assertEquals(await run("public", []), 0);
  assertEquals(await run("private", ["carol@example.com"]), 0);

  const posted = client.calls.ext as [string, unknown][];
  assertEquals(
    posted.every(([path]) => path.startsWith("/api/access/frontend/")),
    true,
  );
  assertEquals(posted.map(([, body]) => body), [
    { private: true, emails: ["alice@example.com"] },
    {
      private: false,
      emails: ["alice@example.com", "bob@example.com", "@team.dev"],
    },
    { private: false, emails: [] },
    { private: false, emails: ["alice@example.com"] },
    { private: true, emails: ["carol@example.com"] },
  ]);
});

Deno.test("access add requires at least one email", async () => {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  await client.createResource("backends", { name: "api", project: p.id });
  const cmds = makeResourceCommands(deps(client, p.id), KINDS.backends);
  await assertRejects(
    () =>
      cmds["backend access add"].run({ name: "api" }, {
        args: [],
        flags: flags({ project: p.id }),
      }),
    CliError,
  );
});
