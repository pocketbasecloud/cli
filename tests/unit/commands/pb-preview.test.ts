import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createdCopies,
  deployToPreview,
  describe,
  discardedMessage,
  lifetimeLabel,
  makePreviewCommands,
  parseEnvOverride,
  planLines,
  type PreviewSummary,
  resolveEnvironment,
  shipLines,
  syncStatus,
  updateLines,
} from "../../../src/commands/pb-preview.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import { CliError } from "../../../src/errors.ts";

type Client = ReturnType<typeof createMockCloudClient>;

const PREVIEW: PreviewSummary = {
  id: "prev00000000001",
  name: "fix-login",
  status: "ready",
  statusMessage: "",
  lifetime: "preview",
  expiresAt: "2026-10-27T12:00:00.000Z",
  data: "copy",
  crons: "off",
  created: "2026-10-20T11:00:00.000Z",
  members: [{
    id: "member000000001",
    kind: "pocketbase",
    name: "db1-fix-login",
    previewOf: "db1",
    baseUrl: "https://member000000001.k7f2.pocketbasecloud.com",
    status: "running",
    statusMessage: "",
  }],
};

function deps(client: Client): CloudCmdDeps {
  const config: Config = {
    ...defaultConfig(),
    cloud: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
  };
  return {
    requireAuth: () => Promise.resolve({ client, config, auth: config.cloud! }),
    loadConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(),
    cwd: () => Deno.makeTempDirSync(),
  };
}

const flags = { json: true, yes: true, noInput: true, interactive: false };

async function setup(
  previews: PreviewSummary[],
  answers: Record<string, Response> = {},
) {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
    status: "running",
  });
  client.ext = (path, body, opts) => {
    client.calls.ext.push([path, body ?? opts?.query]);
    if (path === "/api/previews/list") {
      return Promise.resolve(
        Response.json({ success: true, data: { previews } }),
      );
    }
    return Promise.resolve(
      answers[path] ?? Response.json({ success: true, data: {} }),
    );
  };
  return { client, project: p, pb };
}

async function run(
  client: Client,
  command: string,
  input: Record<string, unknown>,
  projectId: string,
) {
  const out: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = () => {};
  try {
    const code = await makePreviewCommands(deps(client))[command].run(
      input,
      { args: [], flags: { ...flags, project: projectId } },
    );
    return { code, data: JSON.parse(out.at(-1)!).data };
  } finally {
    console.log = log;
    console.error = error;
  }
}

Deno.test("preview ls lists the instance's previews with their addresses", async () => {
  const { client, project, pb } = await setup([PREVIEW]);
  const r = await run(
    client,
    "pocketbase preview ls",
    { name: "db1" },
    project.id,
  );
  assertEquals(r.code, 0);
  assertEquals(client.calls.ext[0], ["/api/previews/list", {
    kind: "pocketbase",
    resourceId: pb.id,
  }]);
  assertEquals(r.data.previews[0].name, "fix-login");
  assertEquals(
    r.data.previews[0].url,
    "https://member000000001.k7f2.pocketbasecloud.com",
  );
});

Deno.test("preview ls says how each preview differs from live", async () => {
  const sync = {
    behind: 2,
    ahead: { added: ["pb_hooks/a.pb.js"], changed: [], removed: [] },
    liveRevision: 9,
    baseRevision: 7,
  };
  const { client, project } = await setup([{ ...PREVIEW, sync }]);
  const r = await run(
    client,
    "pocketbase preview ls",
    { name: "db1" },
    project.id,
  );
  assertEquals(r.data.previews[0].sync, sync);
  assertEquals(syncStatus(sync), "+1 ~0 -0, behind live by 2");
  assertEquals(syncStatus({ ...sync, behind: 0 }), "+1 ~0 -0, up to date");
  assertEquals(syncStatus(undefined), "");
});

Deno.test("preview ship ships the named preview as the CLI", async () => {
  const { client, project } = await setup([PREVIEW], {
    "/api/previews/ship": Response.json({
      success: true,
      data: { deploymentId: "dep1" },
    }),
  });
  const r = await run(
    client,
    "pocketbase preview ship",
    { name: "db1", preview: "fix-login" },
    project.id,
  );
  assertEquals(r.code, 0);
  assertEquals(client.calls.ext.at(-1), [
    "/api/previews/ship",
    { previewId: PREVIEW.id, source: "cli" },
  ]);
  assertEquals(r.data, {
    preview: "fix-login",
    shipped: true,
    target: { id: "live", name: "live" },
    plan: { applied: [], conflicts: [], targetOnly: [], sourceOnly: [] },
    deploymentId: "dep1",
    kept: false,
    members: [],
  });
});

Deno.test("preview ship picks the only preview when none is named", async () => {
  const { client, project } = await setup([PREVIEW]);
  await run(client, "pocketbase preview ship", { name: "db1" }, project.id);
  assertEquals(client.calls.ext.at(-1)?.[1], {
    previewId: PREVIEW.id,
    source: "cli",
  });
});

Deno.test("preview ship needs a name when there are several and input is off", async () => {
  const { client, project } = await setup([PREVIEW, {
    ...PREVIEW,
    id: "prev00000000002",
    name: "preview-2",
  }]);
  const error = await assertRejects(
    () => run(client, "pocketbase preview ship", { name: "db1" }, project.id),
    CliError,
  );
  assertEquals(error.code, "USAGE");
});

Deno.test("preview ship keeps the platform's refusal", async () => {
  const { client, project } = await setup([PREVIEW], {
    "/api/previews/ship": Response.json(
      { success: false, message: "Live changed since this preview was made." },
      { status: 409 },
    ),
  });
  const error = await assertRejects(
    () =>
      run(
        client,
        "pocketbase preview ship",
        { name: "db1", preview: "fix-login" },
        project.id,
      ),
    CliError,
  );
  assertEquals(
    error.message,
    "Ship failed (409): Live changed since this preview was made.",
  );
});

Deno.test("preview rm discards the preview", async () => {
  const { client, project } = await setup([PREVIEW]);
  const r = await run(
    client,
    "pocketbase preview rm",
    { name: "db1", preview: "fix-login" },
    project.id,
  );
  assertEquals(r.code, 0);
  assertEquals(client.calls.ext.at(-1), [
    "/api/previews/discard",
    { previewId: PREVIEW.id },
  ]);
});

Deno.test("discardedMessage names the kept draft, or says nothing was kept", () => {
  assertEquals(
    discardedMessage("fix-login", "fix-login-2"),
    "Discarded fix-login. Its changes are kept as draft fix-login-2: reopen them with `pbc pocketbase preview reopen --draft fix-login-2`.",
  );
  assertEquals(
    discardedMessage("fix-login", null),
    "Discarded fix-login. It had no changes to keep.",
  );
  assertEquals(
    discardedMessage("fix-login", undefined),
    "Discarded fix-login. `pbc pocketbase preview drafts` lists any changes it kept.",
  );
});

Deno.test("an unknown preview name is a not-found error naming the choices", async () => {
  const { client, project } = await setup([PREVIEW]);
  const error = await assertRejects(
    () =>
      run(
        client,
        "pocketbase preview rm",
        { name: "db1", preview: "nope" },
        project.id,
      ),
    CliError,
  );
  assertEquals(error.code, "NOT_FOUND");
});

Deno.test("deployToPreview uploads the archive, creates the preview and waits until it is ready", async () => {
  const { client, pb } = await setup([]);
  const creating = { ...PREVIEW, status: "creating" as const };
  const states = [[], [creating], [creating], [PREVIEW]];
  client.ext = (path, body, opts) => {
    client.calls.ext.push([path, body ?? opts?.query]);
    if (path === "/api/previews/create") {
      return Promise.resolve(Response.json({
        success: true,
        data: {
          previewId: PREVIEW.id,
          memberId: "member000000001",
          deploymentId: "dep1",
        },
      }));
    }
    return Promise.resolve(Response.json({
      success: true,
      data: { previews: states.shift() ?? [PREVIEW] },
    }));
  };
  const uploads: string[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    uploads.push(`${init?.method} ${url}`);
    return Promise.resolve(
      url.endsWith("/api/deployments/upload-url")
        ? Response.json({
          success: true,
          data: { key: "deploys/u_u1/a.zip", uploadUrl: "https://r2/put" },
        })
        : new Response(null, { status: 200 }),
    );
  };
  const result = await deployToPreview(client, {
    baseUrl: "x",
    token: "t",
    fetchFn,
  }, {
    pocketbaseId: pb.id,
    bytes: new Uint8Array([1]),
    name: "fix-login",
    size: "medium",
    keepUsers: ["me@example.com"],
    wait: { intervalMs: 0, timeoutMs: 60_000 },
  });
  assertEquals(uploads, [
    "POST x/api/deployments/upload-url",
    "PUT https://r2/put",
  ]);
  assertEquals(client.calls.ext[0], ["/api/previews/list", {
    kind: "pocketbase",
    resourceId: pb.id,
  }]);
  assertEquals(client.calls.ext[1], ["/api/previews/create", {
    pocketbaseId: pb.id,
    artifactKey: "deploys/u_u1/a.zip",
    name: "fix-login",
    size: "medium",
    keepUsers: ["me@example.com"],
  }]);
  assertEquals(result.preview.name, "fix-login");
  assertEquals(result.deploymentId, "dep1");
});

Deno.test("deployToPreview refuses a full copy of a large database before uploading", async () => {
  const { client, pb } = await setup([]);
  client.ext = (path, body, opts) => {
    client.calls.ext.push([path, body ?? opts?.query]);
    return Promise.resolve(Response.json({
      success: true,
      data: {
        collections: [],
        wholeCopyMaxRows: 100_000,
        fullCopyRefused:
          "Your database has 2,000,000 rows, too many to copy whole. Choose Small or Medium.",
      },
    }));
  };
  const uploads: string[] = [];
  const fetchFn: typeof fetch = (input) => {
    uploads.push(String(input));
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const error = await assertRejects(
    () =>
      deployToPreview(client, { baseUrl: "x", token: "t", fetchFn }, {
        pocketbaseId: pb.id,
        bytes: new Uint8Array([1]),
        size: "full",
      }),
    CliError,
  );
  assertEquals(error.code, "CONFLICT");
  assertEquals(
    error.message.startsWith("Your database has 2,000,000 rows"),
    true,
  );
  assertEquals(client.calls.ext, [[
    "/api/previews/collections",
    { pocketbaseId: pb.id, size: "full" },
  ]]);
  assertEquals(uploads, []);
});

Deno.test("deployToPreview reports the platform's reason when the preview fails", async () => {
  const { client, pb } = await setup([]);
  client.ext = (path) =>
    Promise.resolve(Response.json({
      success: true,
      data: path === "/api/previews/create"
        ? { previewId: PREVIEW.id, memberId: "m", deploymentId: "dep1" }
        : {
          previews: [{
            ...PREVIEW,
            status: "failed",
            statusMessage: "The data is 900 MB.",
          }],
        },
    }));
  const fetchFn: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith("/upload-url")
        ? Response.json({
          success: true,
          data: { key: "k", uploadUrl: "https://r2/put" },
        })
        : new Response(null, { status: 200 }),
    );
  const error = await assertRejects(
    () =>
      deployToPreview(client, { baseUrl: "x", token: "t", fetchFn }, {
        pocketbaseId: pb.id,
        bytes: new Uint8Array([1]),
        wait: { intervalMs: 0, timeoutMs: 60_000 },
      }),
    CliError,
  );
  assertEquals(error.code, "PLATFORM_ERROR");
  assertEquals(error.message, "The data is 900 MB.");
});

Deno.test("preview update says whether the source's newer files came in", async () => {
  const { client, project } = await setup([PREVIEW], {
    "/api/previews/update": Response.json({
      success: true,
      data: { updated: true, conflicts: [] },
    }),
  });
  const r = await run(
    client,
    "pocketbase preview update",
    { name: "db1", preview: "fix-login" },
    project.id,
  );
  assertEquals(client.calls.ext.at(-1), [
    "/api/previews/update",
    { previewId: PREVIEW.id },
  ]);
  assertEquals(r.data, {
    preview: "fix-login",
    updated: true,
    conflicts: [],
    dataCopied: false,
    envCopied: [],
    envFailed: [],
    members: [],
  });
});

const WEB_PREVIEW: PreviewSummary = {
  ...PREVIEW,
  id: "prev00000000005",
  name: "try-nav",
  kind: "frontend",
  resourceId: "web1",
  data: "empty",
  sync: null,
  members: [{
    id: "member000000005",
    kind: "frontend",
    name: "web-try-nav",
    previewOf: "web1",
    baseUrl: "https://member000000005.k7f2.pocketbasecloud.com",
    status: "running",
    statusMessage: "",
  }],
};

async function setupWebsite(
  previews: PreviewSummary[],
  answers: Record<string, Response> = {},
) {
  const fx = await setup(previews, answers);
  const web = await fx.client.createResource("frontends", {
    name: "web",
    project: fx.project.id,
    status: "running",
  });
  return { ...fx, web };
}

Deno.test("website preview ls lists the website's own previews", async () => {
  const { client, project, web } = await setupWebsite([WEB_PREVIEW]);
  const r = await run(
    client,
    "website preview ls",
    { name: "web" },
    project.id,
  );
  assertEquals(client.calls.ext[0], ["/api/previews/list", {
    kind: "frontend",
    resourceId: web.id,
  }]);
  assertEquals(r.data.previews[0].name, "try-nav");
});

Deno.test("website preview update --replace and --copy-env act on its one copy", async () => {
  const preview: PreviewSummary = {
    ...WEB_PREVIEW,
    members: [{ ...WEB_PREVIEW.members[0], deploys: { behind: 1, ahead: 2 } }],
  };
  const { client, project } = await setupWebsite([preview], {
    "/api/previews/update": Response.json({
      success: true,
      data: {
        updated: false,
        conflicts: [],
        members: [{
          id: "member000000005",
          kind: "frontend",
          outcome: "updated",
          diverged: true,
        }],
      },
    }),
  });
  const r = await run(
    client,
    "website preview update",
    { name: "web", replace: true, copyEnv: true },
    project.id,
  );
  assertEquals(client.calls.ext.at(-1), [
    "/api/previews/update",
    { previewId: WEB_PREVIEW.id, env: true, replace: ["member000000005"] },
  ]);
  assertEquals(updateLines(preview, r.data).slice(1), [
    "Replaced: web-try-nav now runs live's build. Its own deploy stays in its history; roll back brings it back.",
  ]);
  assertEquals(
    updateLines(preview, {
      ...r.data,
      members: [{
        id: "member000000005",
        kind: "frontend",
        outcome: "skipped",
        diverged: true,
      }],
    }).slice(1),
    [
      "Kept: web-try-nav keeps its own deploys. Take live's with --replace; its build stays in history.",
    ],
  );
  assertEquals(
    describe(preview).includes("running, changed here and on live"),
    true,
  );
});

Deno.test("preview update --data asks the platform to copy data again", async () => {
  const { client, project } = await setup([PREVIEW], {
    "/api/previews/update": Response.json({
      success: true,
      data: { updated: false, conflicts: [], dataCopied: true },
    }),
  });
  const r = await run(
    client,
    "pocketbase preview update",
    { name: "db1", preview: "fix-login", data: true },
    project.id,
  );
  assertEquals(client.calls.ext.at(-1), [
    "/api/previews/update",
    { previewId: PREVIEW.id, data: true },
  ]);
  assertEquals(r.data.dataCopied, true);
});

Deno.test("PocketBase-only preview commands and flags stay on pbc pocketbase preview", async () => {
  const { client } = await setup([]);
  const commands = makePreviewCommands(deps(client));
  for (const key of ["drafts", "reopen", "drafts rename"]) {
    assertEquals(`pocketbase preview ${key}` in commands, true);
    assertEquals(`website preview ${key}` in commands, false);
    assertEquals(`service preview ${key}` in commands, false);
  }
  assertEquals("pocketbase preview env-diff" in commands, false);
  assertEquals("size" in commands["website preview create"].flags, false);
  assertEquals("data" in commands["service preview update"].flags, false);
  assertEquals("replace" in commands["pocketbase preview update"].flags, false);
  assertEquals(commands["service preview ls"].needs, [
    "target:backends",
    { explicit: true },
  ]);
});

const API_ENV_FAILED =
  "api-staging's env could not be copied. Try Copy from live on its Variables page.";

Deno.test("preview update --data needs confirmation without --yes", async () => {
  const { client, project } = await setup([PREVIEW]);
  const error = await assertRejects(
    () =>
      makePreviewCommands(deps(client))["pocketbase preview update"].run(
        { name: "db1", preview: "fix-login", data: true },
        { args: [], flags: { ...flags, yes: false, project: project.id } },
      ),
    CliError,
  );
  assertEquals(error.code, "USAGE");
  assertEquals(
    client.calls.ext.some(([path]) => path === "/api/previews/update"),
    false,
  );
});

Deno.test("updateLines says files merged, data copied and env keys copied", () => {
  assertEquals(
    updateLines(STAGING, {
      updated: true,
      conflicts: [],
      dataCopied: true,
      envCopied: [
        { memberId: "member000000002", keys: ["A", "B"] },
        { memberId: "member000000003", keys: [] },
      ],
      envFailed: [{ memberId: "member000000003", message: API_ENV_FAILED }],
      members: [],
    }),
    [
      "Files: merged the source's newer files from live.",
      "Data: copied live's data again.",
      "Env: copied A, B onto web-staging.",
      `Env: ${API_ENV_FAILED}`,
    ],
  );
  assertEquals(
    updateLines(PREVIEW, {
      updated: false,
      conflicts: [],
      dataCopied: false,
      envCopied: [],
      envFailed: [],
      members: [],
    }),
    ["Files: fix-login already has the source's newer files."],
  );
  assertEquals(
    updateLines(PREVIEW, {
      updated: true,
      conflicts: ["pb_hooks/a.pb.js"],
      dataCopied: false,
      envCopied: [],
      envFailed: [],
      members: [],
    })[0].startsWith(
      "Files: merged the source's newer files except 1 that both sides changed",
    ),
    true,
  );
});

const DRAFT = {
  id: "draft0000000001",
  name: "fix-login",
  previewName: null,
  changes: { added: ["pb_hooks/a.pb.js"], changed: [], removed: [] },
  updated: "2026-10-21T10:00:00.000Z",
};

Deno.test("preview drafts lists the changes kept from previews", async () => {
  const { client, project, pb } = await setup([], {
    "/api/previews/drafts": Response.json({
      success: true,
      data: { drafts: [DRAFT] },
    }),
  });
  const r = await run(
    client,
    "pocketbase preview drafts",
    { name: "db1" },
    project.id,
  );
  assertEquals(client.calls.ext.at(-1), ["/api/previews/drafts", {
    pocketbaseId: pb.id,
  }]);
  assertEquals(r.data.drafts, [DRAFT]);
});

Deno.test("preview reopen opens the named draft as a new preview", async () => {
  const { client, project, pb } = await setup([PREVIEW], {
    "/api/previews/drafts": Response.json({
      success: true,
      data: { drafts: [DRAFT] },
    }),
    "/api/previews/create": Response.json({
      success: true,
      data: { previewId: PREVIEW.id, memberId: "member000000001" },
    }),
  });
  const r = await run(
    client,
    "pocketbase preview reopen",
    { name: "db1", draft: "fix-login" },
    project.id,
  );
  assertEquals(
    client.calls.ext.find(([path]) => path === "/api/previews/create"),
    ["/api/previews/create", { pocketbaseId: pb.id, draftId: DRAFT.id }],
  );
  assertEquals(r.data, {
    preview: "fix-login",
    url: "https://member000000001.k7f2.pocketbasecloud.com",
    conflicts: [],
  });
});

Deno.test("preview reopen names the drafts there are when the name is wrong", async () => {
  const { client, project } = await setup([], {
    "/api/previews/drafts": Response.json({
      success: true,
      data: { drafts: [DRAFT] },
    }),
  });
  const error = await assertRejects(
    () =>
      run(
        client,
        "pocketbase preview reopen",
        { name: "db1", draft: "nope" },
        project.id,
      ),
    CliError,
  );
  assertEquals(error.code, "NOT_FOUND");
  assertEquals(error.message, "No draft named nope. Drafts: fix-login.");
});

async function runWith(
  client: Client,
  command: string,
  input: Record<string, unknown>,
  args: string[],
  projectId: string,
) {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  try {
    const code = await makePreviewCommands(deps(client))[command].run(
      input,
      { args, flags: { ...flags, project: projectId } },
    );
    return { code, data: JSON.parse(out.at(-1)!).data };
  } finally {
    console.log = log;
  }
}

Deno.test("preview conflicts lists the files to settle", async () => {
  const { client, project } = await setup([PREVIEW], {
    "/api/previews/conflicts": Response.json({
      success: true,
      data: {
        conflicts: [{
          path: "pb_hooks/main.pb.js",
          text: true,
          base: "b",
          mine: "m",
          live: "l",
        }],
      },
    }),
  });
  const r = await run(
    client,
    "pocketbase preview conflicts",
    { name: "db1", preview: "fix-login" },
    project.id,
  );
  assertEquals(client.calls.ext.at(-1), ["/api/previews/conflicts", {
    previewId: PREVIEW.id,
  }]);
  assertEquals(r.data.conflicts[0].path, "pb_hooks/main.pb.js");
});

Deno.test("preview resolve sends the chosen side, or the content of a local file", async () => {
  const { client, project } = await setup([PREVIEW]);
  await runWith(
    client,
    "pocketbase preview resolve",
    { name: "db1", preview: "fix-login", live: true },
    ["pb_hooks/main.pb.js"],
    project.id,
  );
  assertEquals(client.calls.ext.at(-1), ["/api/previews/resolve", {
    previewId: PREVIEW.id,
    path: "pb_hooks/main.pb.js",
    take: "live",
  }]);
  const edited = await Deno.makeTempFile();
  await Deno.writeTextFile(edited, "both\n");
  await runWith(
    client,
    "pocketbase preview resolve",
    { name: "db1", preview: "fix-login", from: edited },
    ["pb_hooks/main.pb.js"],
    project.id,
  );
  assertEquals(client.calls.ext.at(-1), ["/api/previews/resolve", {
    previewId: PREVIEW.id,
    path: "pb_hooks/main.pb.js",
    take: "content",
    content: "both\n",
  }]);
  await Deno.remove(edited);
});

Deno.test("preview resolve needs a file and a choice", async () => {
  const { client, project } = await setup([PREVIEW]);
  const error = await assertRejects(
    () =>
      runWith(
        client,
        "pocketbase preview resolve",
        { name: "db1", preview: "fix-login" },
        ["pb_hooks/main.pb.js"],
        project.id,
      ),
    CliError,
  );
  assertEquals(error.code, "USAGE");
});

Deno.test("preview drafts rename renames the named draft", async () => {
  const { client, project } = await setup([], {
    "/api/previews/drafts": Response.json({
      success: true,
      data: { drafts: [DRAFT] },
    }),
  });
  const r = await runWith(
    client,
    "pocketbase preview drafts rename",
    { name: "db1" },
    ["fix-login", "orders-status"],
    project.id,
  );
  assertEquals(client.calls.ext.at(-1), ["/api/previews/drafts/rename", {
    draftId: DRAFT.id,
    name: "orders-status",
  }]);
  assertEquals(r.data, { draft: "orders-status", previous: "fix-login" });
});

Deno.test("preview conflicts --out writes yours, live's and the original next to each other", async () => {
  const { client, project } = await setup([PREVIEW], {
    "/api/previews/conflicts": Response.json({
      success: true,
      data: {
        conflicts: [{
          path: "pb_hooks/main.pb.js",
          text: true,
          base: "b",
          mine: "m",
          live: null,
        }],
      },
    }),
  });
  const out = await Deno.makeTempDir();
  const r = await run(
    client,
    "pocketbase preview conflicts",
    { name: "db1", preview: "fix-login", out },
    project.id,
  );
  assertEquals(r.data.written, [
    `${out}/pb_hooks/main.pb.js`,
    `${out}/pb_hooks/main.pb.js.original`,
  ]);
  assertEquals(await Deno.readTextFile(`${out}/pb_hooks/main.pb.js`), "m");
  await Deno.remove(out, { recursive: true });
});

Deno.test("deployToPreview with the name of an open preview deploys to it instead of making another", async () => {
  const { client, pb } = await setup([PREVIEW]);
  const posts: string[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    posts.push(`${init?.method} ${url}`);
    if (url.endsWith("/api/deployments/upload-url")) {
      return Promise.resolve(Response.json({
        success: true,
        data: { key: "k", uploadUrl: "https://r2/put" },
      }));
    }
    if (url.endsWith("/api/deployments")) {
      return Promise.resolve(Response.json({
        success: true,
        data: { deploymentId: "dep9" },
      }));
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const result = await deployToPreview(
    client,
    { baseUrl: "x", token: "t", fetchFn },
    { pocketbaseId: pb.id, bytes: new Uint8Array([1]), name: "fix-login" },
  );
  assertEquals(result.deploymentId, "dep9");
  assertEquals(
    client.calls.ext.some(([path]) => path === "/api/previews/create"),
    false,
  );
  assertEquals(posts.at(-1), "POST x/api/deployments");
});

const STAGING: PreviewSummary = {
  ...PREVIEW,
  id: "prev00000000009",
  name: "staging",
  lifetime: "permanent",
  expiresAt: "",
  members: [
    PREVIEW.members[0],
    {
      id: "member000000002",
      kind: "frontend",
      name: "web-staging",
      previewOf: "web1",
      baseUrl: "https://member000000002.k7f2.pocketbasecloud.com",
      status: "running",
      statusMessage: "Build finished",
      deploys: { behind: 1, ahead: 0 },
    },
    {
      id: "member000000003",
      kind: "backend",
      name: "api-staging",
      previewOf: "api1",
      baseUrl: "https://member000000003.k7f2.pocketbasecloud.com",
      status: "running",
      statusMessage: "",
    },
  ],
};

Deno.test("preview ls returns each environment's lifetime and members", async () => {
  const { client, project } = await setup([STAGING]);
  const r = await run(
    client,
    "pocketbase preview ls",
    { name: "db1" },
    project.id,
  );
  assertEquals(r.data.previews[0].lifetime, "permanent");
  assertEquals(r.data.previews[0].members, STAGING.members);
  assertEquals(
    r.data.previews[0].url,
    "https://member000000001.k7f2.pocketbasecloud.com",
  );
  assertEquals(lifetimeLabel(STAGING), "permanent");
  assertEquals(lifetimeLabel(PREVIEW), "expires 2026-10-27T12:00:00.000Z");
});

Deno.test("preview create --permanent sends the kind, the instance and its env overrides", async () => {
  const { client, project, pb } = await setup([STAGING], {
    "/api/previews/create": Response.json({
      success: true,
      data: { previewId: STAGING.id },
    }),
  });
  const r = await runWith(
    client,
    "pocketbase preview create",
    {
      name: "db1",
      permanent: true,
      setEnv: ["MODE=staging", "db1:FLAG=a=b"],
    },
    ["staging"],
    project.id,
  );
  assertEquals(
    client.calls.ext.find(([path]) => path === "/api/previews/create"),
    ["/api/previews/create", {
      kind: "pocketbase",
      resourceId: pb.id,
      lifetime: "permanent",
      name: "staging",
      env: { [pb.id]: { MODE: "staging", FLAG: "a=b" } },
    }],
  );
  assertEquals(r.data.lifetime, "permanent");
});

Deno.test("website preview create sends only the website's kind, id, lifetime and env", async () => {
  const { client, project, web } = await setupWebsite([WEB_PREVIEW], {
    "/api/previews/create": Response.json({
      success: true,
      data: { previewId: WEB_PREVIEW.id },
    }),
  });
  const r = await runWith(
    client,
    "website preview create",
    { name: "web", setEnv: ["VITE_MODE=try", "web:URL=https://x.io"] },
    ["try-nav"],
    project.id,
  );
  assertEquals(
    client.calls.ext.find(([path]) => path === "/api/previews/create"),
    ["/api/previews/create", {
      kind: "frontend",
      resourceId: web.id,
      lifetime: "preview",
      name: "try-nav",
      env: { [web.id]: { VITE_MODE: "try", URL: "https://x.io" } },
    }],
  );
  assertEquals(r.data.preview, "try-nav");
});

Deno.test("preview create lists each copy from the response members", async () => {
  const members = [
    { id: "member000000001", kind: "pocketbase", previewOf: "db1" },
    { id: "member000000002", kind: "frontend", previewOf: "web1" },
  ];
  const { client, project } = await setup([STAGING], {
    "/api/previews/create": Response.json({
      success: true,
      data: { previewId: STAGING.id, members },
    }),
  });
  const r = await runWith(
    client,
    "pocketbase preview create",
    { name: "db1", permanent: true },
    ["staging"],
    project.id,
  );
  assertEquals(r.data.copies, [
    { ...members[0], name: "db1-fix-login" },
    { ...members[1], name: "web-staging" },
  ]);
  assertEquals(
    createdCopies(PREVIEW, undefined).map((copy) => copy.id),
    ["member000000001"],
  );
});

Deno.test("preview ls prints each copy's notice under it", () => {
  const notice =
    "VITE_API_URL pointed at live's PocketBase; this copy uses its own.";
  const lines = describe({
    ...STAGING,
    members: [{ ...STAGING.members[1], notice }],
  }).split("\n");
  assertEquals(lines[1].includes("web-staging"), true);
  assertEquals(lines[2], `      ${notice}`);
  assertEquals(describe(STAGING).includes(notice), false);
});

Deno.test("pocketbase preview create --data empty starts from an empty database", async () => {
  const { client, project } = await setup([PREVIEW], {
    "/api/previews/create": Response.json({
      success: true,
      data: { previewId: PREVIEW.id },
    }),
  });
  await runWith(
    client,
    "pocketbase preview create",
    { name: "db1", data: "empty" },
    [],
    project.id,
  );
  const body = client.calls.ext.find(([path]) =>
    path === "/api/previews/create"
  )?.[1] as Record<string, unknown>;
  assertEquals(body.data, "empty");
  const commands = makePreviewCommands(deps(client));
  assertEquals(
    commands["pocketbase preview create"].usage.includes(
      "[--data copy|empty]",
    ),
    true,
  );
  assertEquals("data" in commands["website preview create"].flags, false);
});

Deno.test("preview create defaults to a preview and refuses env for another resource", async () => {
  const { client, project } = await setup([PREVIEW], {
    "/api/previews/create": Response.json({
      success: true,
      data: { previewId: PREVIEW.id },
    }),
  });
  await runWith(
    client,
    "pocketbase preview create",
    { name: "db1" },
    [],
    project.id,
  );
  assertEquals(
    (client.calls.ext.find(([path]) => path === "/api/previews/create")
      ?.[1] as Record<string, unknown>).lifetime,
    "preview",
  );
  const calls = client.calls.ext.length;
  const error = await assertRejects(
    () =>
      runWith(
        client,
        "pocketbase preview create",
        { name: "db1", setEnv: ["web:A=1"] },
        [],
        project.id,
      ),
    CliError,
  );
  assertEquals(error.code, "USAGE");
  assertEquals(
    error.message,
    "--set-env web:A=1 names web, but this copies db1. Write KEY=VALUE.",
  );
  assertEquals(
    client.calls.ext.slice(calls).some(([path]) =>
      path === "/api/previews/create"
    ),
    false,
  );
});

Deno.test("parseEnvOverride reads KEY=VALUE or RESOURCE:KEY=VALUE and refuses anything else", () => {
  assertEquals(parseEnvOverride("web:A=b:c=d"), {
    resource: "web",
    key: "A",
    value: "b:c=d",
  });
  assertEquals(parseEnvOverride("URL=https://x.io:8080"), {
    key: "URL",
    value: "https://x.io:8080",
  });
  assertEquals(parseEnvOverride("web:EMPTY=").value, "");
  for (const bad of ["web", "web:A", ":A=1", "web:=1", "=1"]) {
    const error = assertThrows(() => parseEnvOverride(bad), CliError);
    assertEquals(error.code, "USAGE");
  }
});

Deno.test("preview ship lists each member's outcome and keeps a permanent environment", async () => {
  const members = [
    {
      id: "member000000001",
      kind: "pocketbase" as const,
      outcome: "shipped" as const,
    },
    {
      id: "member000000002",
      kind: "frontend" as const,
      outcome: "refused" as const,
      message: "Live was deployed since.",
    },
  ];
  const { client, project } = await setup([STAGING], {
    "/api/previews/ship": Response.json({
      success: true,
      data: { deploymentId: "dep1", members },
    }),
  });
  const r = await run(
    client,
    "pocketbase preview ship",
    { name: "db1", preview: "staging" },
    project.id,
  );
  assertEquals(r.data.kept, true);
  assertEquals(r.data.members, members);
  assertEquals(shipLines(STAGING, "db1", members, true), [
    "Shipped staging to db1.",
    "  PocketBase  db1-fix-login  shipped",
    "  website  web-staging  refused: Live was deployed since.",
    "staging is a permanent environment and is kept.",
  ]);
  assertEquals(
    shipLines(PREVIEW, "db1", [], false).at(-1),
    "The preview was deleted.",
  );
  assertEquals(
    shipLines(PREVIEW, "staging", [], true).at(-1),
    "fix-login is kept, so you can ship it on to live later.",
  );
});

Deno.test("preview extend explains a permanent environment does not expire", async () => {
  const { client, project } = await setup([STAGING]);
  const error = await assertRejects(
    () =>
      run(
        client,
        "pocketbase preview extend",
        { name: "db1", preview: "staging" },
        project.id,
      ),
    CliError,
  );
  assertEquals(error.code, "CONFLICT");
  assertEquals(
    error.message,
    "staging is a permanent environment: it does not expire, so there is nothing to extend.",
  );
  assertEquals(
    client.calls.ext.some(([path]) => path === "/api/previews/extend"),
    false,
  );
});

Deno.test("website preview env-diff asks about the preview's one copy", async () => {
  const keys = [{ key: "API_URL", state: "different" }];
  const { client, project } = await setupWebsite([WEB_PREVIEW], {
    "/api/previews/env-diff": Response.json({ success: true, data: { keys } }),
  });
  const r = await runWith(
    client,
    "website preview env-diff",
    { name: "web" },
    ["try-nav"],
    project.id,
  );
  assertEquals(client.calls.ext.at(-1), ["/api/previews/env-diff", {
    previewId: WEB_PREVIEW.id,
    memberId: "member000000005",
  }]);
  assertEquals(r.data, { preview: "try-nav", member: "web-try-nav", keys });
});

Deno.test("website preview env-copy copies the chosen keys onto its one copy", async () => {
  const { client, project } = await setupWebsite([WEB_PREVIEW], {
    "/api/previews/env-copy": Response.json({
      success: true,
      data: { copied: ["API_URL"] },
    }),
  });
  const r = await runWith(
    client,
    "website preview env-copy",
    { name: "web", key: ["API_URL"] },
    ["try-nav"],
    project.id,
  );
  assertEquals(client.calls.ext.at(-1), ["/api/previews/env-copy", {
    previewId: WEB_PREVIEW.id,
    memberId: "member000000005",
    keys: ["API_URL"],
  }]);
  assertEquals(r.data.copied, ["API_URL"]);
});

const FROM_STAGING: PreviewSummary = {
  ...PREVIEW,
  copiedFrom: { id: STAGING.id, name: "staging", status: "ready" },
};

Deno.test("preview ls shows where each preview was copied from", async () => {
  const { client, project } = await setup([STAGING, FROM_STAGING]);
  const r = await run(
    client,
    "pocketbase preview ls",
    { name: "db1" },
    project.id,
  );
  assertEquals(r.data.previews[0].copiedFrom, null);
  assertEquals(r.data.previews[1].copiedFrom, FROM_STAGING.copiedFrom);
  assertEquals(
    describe({
      ...FROM_STAGING,
      sync: {
        behind: 2,
        ahead: { added: [], changed: [], removed: [] },
        liveRevision: 3,
        baseRevision: 1,
      },
    }).split("\n")[0].endsWith("from staging  +0 ~0 -0, behind staging by 2"),
    true,
  );
  assertEquals(
    describe({
      ...FROM_STAGING,
      copiedFrom: { ...FROM_STAGING.copiedFrom!, status: "deleted" },
    }).split("\n")[0].endsWith("from staging (discarded)"),
    true,
  );
  assertEquals(describe(PREVIEW).split("\n")[0].endsWith("from live"), true);
});

Deno.test("preview create --from sends the environment's id", async () => {
  const { client, project, pb } = await setup([STAGING, FROM_STAGING], {
    "/api/previews/create": Response.json({
      success: true,
      data: { previewId: FROM_STAGING.id },
    }),
  });
  const r = await runWith(
    client,
    "pocketbase preview create",
    { name: "db1", from: "staging" },
    ["fix-login"],
    project.id,
  );
  assertEquals(
    client.calls.ext.find(([path]) => path === "/api/previews/create"),
    ["/api/previews/create", {
      kind: "pocketbase",
      resourceId: pb.id,
      lifetime: "preview",
      name: "fix-login",
      from: STAGING.id,
    }],
  );
  assertEquals(r.data.copiedFrom, FROM_STAGING.copiedFrom);
});

Deno.test("preview create --from live sends no source", async () => {
  const { client, project } = await setup([PREVIEW], {
    "/api/previews/create": Response.json({
      success: true,
      data: { previewId: PREVIEW.id },
    }),
  });
  await runWith(
    client,
    "pocketbase preview create",
    { name: "db1", from: "live" },
    [],
    project.id,
  );
  assertEquals(
    "from" in
      (client.calls.ext.find(([path]) => path === "/api/previews/create")
        ?.[1] as Record<string, unknown>),
    false,
  );
});

Deno.test("preview create --from refuses a preview or an unknown name", async () => {
  const { client, project } = await setup([STAGING, PREVIEW]);
  const preview = await assertRejects(
    () =>
      runWith(
        client,
        "pocketbase preview create",
        { name: "db1", from: "fix-login" },
        [],
        project.id,
      ),
    CliError,
  );
  assertEquals(preview.code, "USAGE");
  assertEquals(
    preview.message,
    "fix-login is a preview, not an environment. Copy from one of: live, staging.",
  );
  const unknown = await assertRejects(
    () =>
      runWith(
        client,
        "pocketbase preview create",
        { name: "db1", from: "qa" },
        [],
        project.id,
      ),
    CliError,
  );
  assertEquals(unknown.code, "NOT_FOUND");
  assertEquals(
    client.calls.ext.some(([path]) => path === "/api/previews/create"),
    false,
  );
});

Deno.test("resolveEnvironment refuses shipping an environment to itself", () => {
  assertEquals(resolveEnvironment([STAGING], "live", "ship", STAGING), "live");
  const error = assertThrows(
    () => resolveEnvironment([STAGING], "staging", "ship", STAGING),
    CliError,
  );
  assertEquals(
    error.message,
    "staging can't ship to itself. Ship to one of: live.",
  );
});

const PLAN = {
  target: { id: STAGING.id, name: "staging" },
  plan: {
    applied: ["pb_hooks/a.pb.js"],
    conflicts: ["pb_hooks/c.pb.js"],
    targetOnly: ["pb_hooks/t.pb.js", "pb_public/index.html"],
    sourceOnly: [],
  },
  members: [
    {
      id: "w1",
      kind: "frontend" as const,
      name: "web",
      action: "ship" as const,
    },
    {
      id: "s1",
      kind: "backend" as const,
      name: "api",
      action: "skip" as const,
      message: "staging has no copy of api; add it to staging first",
    },
  ],
};

Deno.test("preview ship --to asks for the plan against that target, then ships there", async () => {
  const { client, project } = await setup([STAGING, FROM_STAGING], {
    "/api/previews/changes": Response.json({ success: true, data: PLAN }),
    "/api/previews/ship": Response.json({
      success: true,
      data: { deploymentId: "dep1", kept: true, members: [] },
    }),
  });
  const r = await run(
    client,
    "pocketbase preview ship",
    { name: "db1", preview: "fix-login", to: "staging" },
    project.id,
  );
  assertEquals(client.calls.ext.slice(-2), [
    ["/api/previews/changes", { previewId: PREVIEW.id, to: STAGING.id }],
    ["/api/previews/ship", {
      previewId: PREVIEW.id,
      source: "cli",
      to: STAGING.id,
    }],
  ]);
  assertEquals(r.data.kept, true);
  assertEquals(r.data.target, PLAN.target);
  assertEquals(r.data.plan, PLAN.plan);
});

Deno.test("preview ship without --to lets the platform pick the source", async () => {
  const { client, project } = await setup([FROM_STAGING]);
  await run(
    client,
    "pocketbase preview ship",
    { name: "db1", preview: "fix-login" },
    project.id,
  );
  assertEquals(client.calls.ext.slice(-2), [
    ["/api/previews/changes", { previewId: PREVIEW.id }],
    ["/api/previews/ship", { previewId: PREVIEW.id, source: "cli" }],
  ]);
});

Deno.test("preview ship refuses a preview as the target before shipping", async () => {
  const other = { ...PREVIEW, id: "prev00000000003", name: "other" };
  const { client, project } = await setup([STAGING, FROM_STAGING, other]);
  const error = await assertRejects(
    () =>
      run(
        client,
        "pocketbase preview ship",
        { name: "db1", preview: "fix-login", to: "other" },
        project.id,
      ),
    CliError,
  );
  assertEquals(
    error.message,
    "other is a preview, not an environment. Ship to one of: live, staging.",
  );
  assertEquals(
    client.calls.ext.some(([path]) => path === "/api/previews/ship"),
    false,
  );
});

Deno.test("planLines lists applied, kept, conflicting and skipped changes", () => {
  assertEquals(planLines(FROM_STAGING, PLAN), [
    "Shipping fix-login to staging:",
    "  1 file(s) applied:",
    "    pb_hooks/a.pb.js",
    "  2 change(s) on staging this preview hasn't seen; they'll be kept:",
    "    pb_hooks/t.pb.js",
    "    pb_public/index.html",
    "  1 file(s) changed in the same place on both; shipping stops until each is settled with `pbc pocketbase preview resolve <file> --preview fix-login --mine|--live|--from <path>`:",
    "    pb_hooks/c.pb.js",
    "  website  web  ship",
    "  service  api  skip: staging has no copy of api; add it to staging first",
  ]);
  const toLive = planLines(FROM_STAGING, {
    target: { id: "live", name: "live" },
    plan: {
      applied: [],
      conflicts: [],
      targetOnly: [],
      sourceOnly: ["pb_migrations/1_a.js"],
    },
    members: [],
  });
  assertEquals(toLive, [
    "Shipping fix-login to live:",
    "  No PocketBase file changes to apply.",
    "  Copied from staging, which has 1 change(s) live doesn't. Ship staging to live first if this change depends on them:",
    "    pb_migrations/1_a.js",
  ]);
});
