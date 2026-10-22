import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  makePbMoveCommands,
  type MoveOptions,
  moveSummary,
  type MoveTarget,
} from "../../../src/commands/pb-move.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { type Config, defaultConfig } from "../../../src/config.ts";
import type { CloudCmdDeps } from "../../../src/commands/project.ts";
import type { Resource } from "../../../src/clients/types.ts";
import { CliError } from "../../../src/errors.ts";
import { KINDS } from "../../../src/kinds.ts";
import { renderDetail } from "../../../src/ui/output.ts";

type Client = ReturnType<typeof createMockCloudClient>;

const STARTER: MoveTarget = {
  serverId: "srvstarter00001",
  kind: "pool",
  location: "GRA",
  newAddress: "https://db1.m9q4.pocketbasecloud.com",
  ip: "203.0.113.7",
};
const SECOND: MoveTarget = {
  serverId: "srvstarter00002",
  kind: "pool",
  location: "SBG",
  newAddress: "https://db1.k2p8.pocketbasecloud.com",
};
const WAIT = { intervalMs: 0, timeoutMs: 60_000 };

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

const flags = (over: Record<string, unknown> = {}) => ({
  json: true,
  yes: true,
  noInput: true,
  interactive: false,
  ...over,
});

async function setup(options: MoveOptions, after: Partial<Resource>[] = []) {
  const client = createMockCloudClient();
  const p = await client.createProject("app");
  const pb = await client.createResource("pocketbases", {
    name: "db1",
    project: p.id,
    status: "running",
    domain: "db1.free1.pocketbasecloud.com",
  });
  client.ext = (path, body, opts) => {
    client.calls.ext.push([path, body ?? opts?.query]);
    if (path === "/api/pocketbases/move-options") {
      return Promise.resolve(Response.json({ success: true, data: options }));
    }
    return Promise.resolve(
      Response.json({ success: true, data: {} }, { status: 202 }),
    );
  };
  const states = [...after];
  let polls = 0;
  client.getResource = () => {
    polls++;
    return Promise.resolve({ ...pb, ...(states.shift() ?? {}) } as Resource);
  };
  return { client, project: p, pb, polls: () => polls };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  return {
    out,
    err,
    restore: () => {
      console.log = log;
      console.error = error;
    },
  };
}

async function run(
  client: Client,
  command: string,
  input: Record<string, unknown>,
  over: Record<string, unknown> = {},
) {
  const io = capture();
  try {
    const code = await makePbMoveCommands(deps(client), WAIT)[command].run(
      input,
      { args: [], flags: flags(over) },
    );
    return { code, ...io };
  } finally {
    io.restore();
  }
}

const needed = (targets: MoveTarget[]): MoveOptions => ({
  needsMove: true,
  plan: "starter",
  fromFreeCluster: true,
  targets,
});

Deno.test("move starts the move, waits for it, and reports the new address", async () => {
  const { client, pb, project } = await setup(needed([STARTER]), [
    { status: "deploying", subStatus: "moving" },
    {
      status: "running",
      subStatus: "",
      domain: "db1.m9q4.pocketbasecloud.com",
      previousDomain: "db1.free1.pocketbasecloud.com",
      movedAt: "2026-10-20T10:00:00Z",
    },
  ]);
  const r = await run(client, "pocketbase move", { name: "db1" }, {
    project: project.id,
  });
  assertEquals(r.code, 0);
  assertEquals(client.calls.ext.map(([path]) => path), [
    "/api/pocketbases/move-options",
    "/api/pocketbases/move",
  ]);
  assertEquals(client.calls.ext[1][1], {
    pocketbaseId: pb.id,
    serverId: STARTER.serverId,
  });
  assertEquals(JSON.parse(r.out.at(-1)!).data, {
    id: pb.id,
    moved: true,
    domain: "db1.m9q4.pocketbasecloud.com",
    previousDomain: "db1.free1.pocketbasecloud.com",
    movedAt: "2026-10-20T10:00:00Z",
  });
  assertStringIncludes(r.err.join("\n"), "New address  " + STARTER.newAddress);
});

Deno.test("move reports the platform's reason when the move rolls back", async () => {
  const { client, project } = await setup(needed([STARTER]), [
    {
      status: "running",
      subStatus: "moveFailed",
      statusMessage:
        "Your instance is running where it was, with nothing changed.",
    },
  ]);
  const error = await assertRejects(
    () =>
      run(client, "pocketbase move", { name: "db1" }, { project: project.id }),
    CliError,
  );
  assertEquals(error.code, "PLATFORM_ERROR");
  assertEquals(
    error.message,
    "Your instance is running where it was, with nothing changed.",
  );
});

Deno.test("move --no-wait returns once the move has started", async () => {
  const s = await setup(needed([STARTER]));
  const r = await run(s.client, "pocketbase move", {
    name: "db1",
    noWait: true,
  }, { project: s.project.id });
  assertEquals(r.code, 0);
  assertEquals(s.polls(), 0);
  assertEquals(JSON.parse(r.out.at(-1)!).data.status, "moving");
});

Deno.test("move takes an instance to another compute when no move is recommended", async () => {
  const compute: MoveTarget = { ...SECOND, kind: "compute" };
  const s = await setup(
    {
      needsMove: false,
      plan: "pro",
      fromFreeCluster: false,
      targets: [compute],
    },
    [{ status: "running" }],
  );
  const r = await run(s.client, "pocketbase move", { name: "db1" }, {
    project: s.project.id,
  });
  assertEquals(r.code, 0);
  assertEquals(s.client.calls.ext[1][1], {
    pocketbaseId: s.pb.id,
    serverId: compute.serverId,
  });
  assertStringIncludes(r.err.join("\n"), "Move db1 to another compute:");
});

Deno.test("move refuses an instance its plan places for it", async () => {
  const { client, project } = await setup({
    needsMove: false,
    plan: "starter",
    fromFreeCluster: false,
    blockedReason:
      "Starter instances are placed on the Starter cluster for you.",
    targets: [],
  });
  const error = await assertRejects(
    () =>
      run(client, "pocketbase move", { name: "db1" }, { project: project.id }),
    CliError,
  );
  assertEquals(error.code, "CONFLICT");
  assertEquals(client.calls.ext.length, 1);
});

Deno.test("move surfaces the platform's blocked reason as a conflict", async () => {
  const { client, project } = await setup({
    ...needed([]),
    blockedReason: "Turn off continuous backup before moving.",
  });
  const error = await assertRejects(
    () =>
      run(client, "pocketbase move", { name: "db1" }, { project: project.id }),
    CliError,
  );
  assertEquals(error.code, "CONFLICT");
  assertEquals(error.message, "Turn off continuous backup before moving.");
});

Deno.test("move asks for --to when several computes fit and it cannot prompt", async () => {
  const { client, project } = await setup(needed([STARTER, SECOND]));
  const error = await assertRejects(
    () =>
      run(client, "pocketbase move", { name: "db1" }, { project: project.id }),
    CliError,
  );
  assertEquals(error.code, "USAGE");
  assertStringIncludes(error.message, SECOND.serverId);
});

Deno.test("move --to picks that compute and refuses one not offered", async () => {
  const s = await setup(needed([STARTER, SECOND]), [{ status: "running" }]);
  await run(s.client, "pocketbase move", {
    name: "db1",
    to: SECOND.serverId,
  }, { project: s.project.id });
  assertEquals(
    (s.client.calls.ext.at(-1)![1] as { serverId: string }).serverId,
    SECOND.serverId,
  );

  const error = await assertRejects(
    () =>
      run(s.client, "pocketbase move", { name: "db1", to: "srvelsewhere001" }, {
        project: s.project.id,
      }),
    CliError,
  );
  assertEquals(error.code, "INVALID_VALUE");
});

Deno.test("move needs --yes when it cannot ask", async () => {
  const { client, project } = await setup(needed([STARTER]));
  const error = await assertRejects(
    () =>
      run(client, "pocketbase move", { name: "db1" }, {
        project: project.id,
        yes: false,
      }),
    CliError,
  );
  assertEquals(error.code, "USAGE");
  assertEquals(client.calls.ext.length, 1);
});

Deno.test("move summary gives custom domain DNS steps", () => {
  const resource = {
    id: "pb1234567890abc",
    name: "db1",
    status: "running",
    project: "p",
    createdBy: "u1",
    custom_domain: "api.example.com",
  } as Resource;
  assertStringIncludes(
    moveSummary(resource, STARTER, "Starter cluster").join("\n"),
    "a CNAME at pb1234567890abc.pocketbasecloud.com (or an A record at 203.0.113.7)",
  );
  assertStringIncludes(
    moveSummary({ ...resource, custom_domain: "example.com" }, STARTER, "x")
      .join("\n"),
    "an A record at 203.0.113.7",
  );
});

Deno.test("previous-copy rm deletes it and refuses an instance never moved", async () => {
  const s = await setup(needed([]));
  const notMoved = await assertRejects(
    () =>
      run(s.client, "pocketbase previous-copy rm", { name: "db1" }, {
        project: s.project.id,
      }),
    CliError,
  );
  assertEquals(notMoved.code, "NOT_FOUND");

  await s.client.updateResource("pocketbases", s.pb.id, {
    previousDomain: "db1.free1.pocketbasecloud.com",
  });
  const r = await run(s.client, "pocketbase previous-copy rm", {
    name: "db1",
  }, { project: s.project.id });
  assertEquals(r.code, 0);
  assertEquals(s.client.calls.ext.at(-1), [
    "/api/pocketbases/previous-copy/delete",
    { pocketbaseId: s.pb.id },
  ]);
});

Deno.test("info shows a move in progress and the forwarding old address", () => {
  const base = {
    id: "pb1",
    name: "db1",
    project: "p",
    createdBy: "u1",
  };
  const moving = renderDetail(
    { ...base, status: "deploying", subStatus: "moving" } as Resource,
    KINDS.pocketbases.fields,
  );
  assertMatch(moving, /^STATUS\s+moving$/m);
  const moved = renderDetail(
    {
      ...base,
      status: "running",
      previousDomain: "db1.free1.pocketbasecloud.com",
    } as Resource,
    KINDS.pocketbases.fields,
  );
  assertStringIncludes(
    moved,
    "db1.free1.pocketbasecloud.com (forwards here until the previous copy is deleted)",
  );
});
