import { assertEquals, assertRejects } from "@std/assert";
import {
  deployToPreview,
  discardedMessage,
  makePbPreviewCommands,
  type PreviewSummary,
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
  expiresAt: "2026-10-27T12:00:00.000Z",
  data: "copy",
  crons: "off",
  created: "2026-10-20T11:00:00.000Z",
  members: [{
    id: "member000000001",
    kind: "pocketbase",
    previewOf: "db1",
    baseUrl: "https://member000000001.k7f2.pocketbasecloud.com",
    status: "running",
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
    const code = await makePbPreviewCommands(deps(client))[command].run(
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
    pocketbaseId: pb.id,
  }]);
  assertEquals(r.data.previews[0].name, "fix-login");
  assertEquals(
    r.data.previews[0].url,
    "https://member000000001.k7f2.pocketbasecloud.com",
  );
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
    deploymentId: "dep1",
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
    pocketbaseId: pb.id,
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

Deno.test("preview update says whether live's newer files came in", async () => {
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
  assertEquals(r.data, { preview: "fix-login", updated: true, conflicts: [] });
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
    const code = await makePbPreviewCommands(deps(client))[command].run(
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
