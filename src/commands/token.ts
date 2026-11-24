import { type Command, defineCommand } from "../command.ts";
import type { CloudAuth, Config } from "../config.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError, httpError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { printResult } from "../ui/output.ts";

type TokenSummary = {
  id: string;
  name: string;
  kind: string;
  prefix: string;
  project: string;
  lastUsedAt: string;
  revokedAt: string;
  expiresAt: string;
};

export type TokenDeps = {
  requireAuth: () => Promise<
    { client: ICloudClient; config: Config; auth: CloudAuth }
  >;
  portalBase: string;
  open: (url: string) => void;
  linkedProject: () => Promise<string | null>;
};

const TOKENS_PAGE = "/account";
const TOKENS_ANCHOR = "#ci-token";

function createTokenUrl(portalBase: string, project: string | null): string {
  const query = project ? `?${new URLSearchParams({ project })}` : "";
  return `${portalBase}${TOKENS_PAGE}${query}${TOKENS_ANCHOR}`;
}

async function listTokens(client: ICloudClient): Promise<TokenSummary[]> {
  const res = await client.ext("/api/access-tokens/list", {});
  if (!res.ok) throw await httpError(res, "Listing tokens");
  return ((await res.json()) as { data: TokenSummary[] }).data;
}

function matching(tokens: TokenSummary[], ref: string): TokenSummary {
  const found = tokens.filter((t) =>
    !t.revokedAt &&
    (t.id === ref || t.prefix.startsWith(ref) || ref.startsWith(t.prefix))
  );
  if (found.length === 1) return found[0];
  throw new CliError(
    found.length === 0
      ? `No active token matches "${ref}". Run \`pbc token ls\`.`
      : `"${ref}" matches ${found.length} tokens; give more of the prefix or the id.`,
    { code: "USAGE" },
  );
}

function tryOpen(deps: TokenDeps, url: string): boolean {
  try {
    deps.open(url);
    return true;
  } catch {
    return false;
  }
}

export function makeTokenCommands(deps: TokenDeps): Record<string, Command> {
  return {
    "token ls": defineCommand({
      path: ["token", "ls"],
      usage: "pbc token ls",
      summary: "List your access tokens and logged-in devices.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client } = await deps.requireAuth();
        const tokens = await listTokens(client);
        printResult(tokens, [
          { header: "ID", get: (t) => t.id },
          { header: "NAME", get: (t) => t.name },
          { header: "KIND", get: (t) => t.kind },
          { header: "PREFIX", get: (t) => `${t.prefix}…` },
          { header: "PROJECT", get: (t) => t.project || "all" },
          { header: "LAST USED", get: (t) => t.lastUsedAt || "never" },
          {
            header: "STATUS",
            get: (t) => (t.revokedAt ? "revoked" : "active"),
          },
        ], ctx.flags.json);
        return 0;
      },
    }),

    "token revoke": defineCommand({
      path: ["token", "revoke"],
      usage: "pbc token revoke <id|prefix>",
      summary: "Revoke an access token or a device login.",
      args: [{
        name: "token",
        required: true,
        description: "Token id or the start of its prefix",
      }],
      flags: {},
      run: async (_input, ctx) => {
        const ref = ctx.args[0];
        if (!ref) {
          throw new CliError("Usage: pbc token revoke <id|prefix>", {
            code: "USAGE",
          });
        }
        const { client } = await deps.requireAuth();
        const token = matching(await listTokens(client), ref);
        const res = await client.ext("/api/access-tokens/revoke", {
          id: token.id,
        });
        if (!res.ok) throw await httpError(res, "Revoking the token");
        await res.body?.cancel();
        emit(
          ctx.flags.json,
          { id: token.id, revoked: true },
          `Revoked ${token.name} (${token.prefix}…).`,
        );
        return 0;
      },
    }),

    "token create": defineCommand({
      path: ["token", "create"],
      usage: "pbc token create",
      summary: "Open the portal page that creates an access token.",
      details:
        `Tokens are created only in the portal, signed in as yourself, so a
stolen login can never mint a token that outlives it. Inside a directory with
pbc.json, the page starts limited to that project.`,
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const url = createTokenUrl(
          deps.portalBase,
          await deps.linkedProject(),
        );
        const opened = tryOpen(deps, url);
        emit(
          ctx.flags.json,
          { url, opened },
          `Create the token at ${url}`,
        );
        return 0;
      },
    }),
  };
}
