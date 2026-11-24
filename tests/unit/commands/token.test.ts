import { assertEquals, assertRejects } from "@std/assert";
import { makeTokenCommands } from "../../../src/commands/token.ts";
import { createMockCloudClient } from "../../mocks/cloud.mock.ts";
import { defaultConfig } from "../../../src/config.ts";
import { CliError } from "../../../src/errors.ts";

const TOKENS = [
  {
    id: "tokaaaaaaaaaaaa",
    name: "CI",
    kind: "automation",
    prefix: "pbc_a_AbCdEf",
    project: "",
    permissions: ["read"],
    lastUsedAt: "",
    revokedAt: "",
    expiresAt: "",
  },
  {
    id: "devaaaaaaaaaaaa",
    name: "MacBook",
    kind: "device",
    prefix: "pbc_d_XyZ123",
    project: "",
    permissions: ["read"],
    lastUsedAt: "",
    revokedAt: "",
    expiresAt: "",
  },
];

function setup(linkedProject: string | null = null) {
  const client = createMockCloudClient({
    ext: (path: string, body?: unknown) => {
      client.calls.ext.push([path, body]);
      return Promise.resolve(
        Response.json({
          success: true,
          data: path.endsWith("/list") ? TOKENS : undefined,
        }),
      );
    },
  });
  const opened: string[] = [];
  const cmds = makeTokenCommands({
    requireAuth: () =>
      Promise.resolve({
        client,
        config: defaultConfig(),
        auth: { backendUrl: "u", extUrl: "x", userToken: "t", userId: "u1" },
      }),
    portalBase: "https://portal.test",
    open: (url) => opened.push(url),
    linkedProject: () => Promise.resolve(linkedProject),
  });
  return { cmds, client, opened };
}

const flags = { json: true, yes: true, noInput: true, interactive: false };

Deno.test("token revoke takes an id or a prefix", async () => {
  const { cmds, client } = setup();
  await cmds["token revoke"].run({}, { args: ["pbc_d_XyZ"], flags });
  assertEquals(client.calls.ext.at(-1), ["/api/access-tokens/revoke", {
    id: "devaaaaaaaaaaaa",
  }]);
  await cmds["token revoke"].run({}, { args: ["tokaaaaaaaaaaaa"], flags });
  assertEquals(client.calls.ext.at(-1), ["/api/access-tokens/revoke", {
    id: "tokaaaaaaaaaaaa",
  }]);
  await assertRejects(
    () => cmds["token revoke"].run({}, { args: ["pbc_"], flags }),
    CliError,
  );
});

Deno.test("token create opens the portal, where tokens are made", async () => {
  const { cmds, opened, client } = setup();
  await cmds["token create"].run({}, { args: [], flags });
  assertEquals(opened, ["https://portal.test/account#ci-token"]);
  assertEquals(client.calls.ext, []);
});

Deno.test("token create prefills the project this directory deploys to", async () => {
  const { cmds, opened } = setup("abcdefghij12345");
  await cmds["token create"].run({}, { args: [], flags });
  assertEquals(opened, ["https://portal.test/account?project=abcdefghij12345#ci-token"]);
});
