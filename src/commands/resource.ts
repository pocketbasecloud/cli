import {
  type CmdCtx,
  type Command,
  defineCommand,
  type Need,
  requiresExplicitTarget,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource } from "../clients/types.ts";
import { type KindSpec, kindPlural } from "../kinds.ts";
import { CliError, httpError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { printDetail, printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";
import { resolveResourceTarget } from "../resolve/target.ts";
import { removeEnvironmentFor } from "../config.ts";
import { reportRemoval } from "./environments.ts";

const DOMAIN_SUMMARIES = {
  add: "Add a custom domain.",
  verify: "Verify a custom domain.",
  remove: "Remove a custom domain.",
  status: "Check whether the custom domain is reachable.",
} as const;

type DomainVerb = keyof typeof DOMAIN_SUMMARIES;

function withoutAdminCredentials(resource: Resource): Resource {
  const listed = { ...resource } as Resource & {
    adminUsername?: unknown;
    adminPassword?: unknown;
  };
  delete listed.adminUsername;
  delete listed.adminPassword;
  return listed;
}

export type ResourceResolver = {
  resolveOne: (
    ctx: CmdCtx,
    input: { name?: string; id?: string; env?: string },
    opts?: { needs?: readonly Need[]; args?: string[] },
  ) => Promise<
    { client: ICloudClient; found: Resource; environment: string }
  >;
};

export function makeResourceResolver(
  deps: CloudCmdDeps,
  spec: KindSpec,
): ResourceResolver {
  async function resolveOne(
    ctx: CmdCtx,
    input: { name?: string; id?: string; env?: string },
    opts: { needs?: readonly Need[]; args?: string[] } = {},
  ) {
    const args = opts.args ?? ctx.args;
    const { client, config } = await deps.requireAuth();
    const { resource, environment } = await resolveResourceTarget({
      client,
      spec,
      cwd: deps.cwd(),
      name: input.name ?? args[0],
      id: input.id,
      envFlag: input.env,
      projectFilter: ctx.flags.project,
      config,
      explicit: requiresExplicitTarget({ needs: opts.needs }),
      noInput: ctx.flags.noInput || ctx.flags.json,
      io: deps.io,
      log: (m) => console.error(m),
    });
    return { client, found: resource, environment };
  }

  return { resolveOne };
}

export function makeResourceCommands(
  deps: CloudCmdDeps,
  spec: KindSpec,
): Record<string, Command> {
  const { resolveOne } = makeResourceResolver(deps, spec);

  const targetNeed: Need = `target:${spec.kind}`;
  const addresses: readonly Need[] = [targetNeed];
  const addressesToMutate: readonly Need[] = [targetNeed, { explicit: true }];

  async function project(ctx: CmdCtx) {
    const { client, config } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput || ctx.flags.json,
      log: (m) => console.error(m),
    });
    return { client, project: p };
  }

  const positional = {
    name: "name",
    required: false,
    description: "Positional name, alternative to --name/--id",
  };
  const idFlag = str({
    description: `The ${spec.idNoun}'s id, alternative to --name.`,
  });
  const envFlag = str({ description: "Which pbc.json environment to target." });

  function domainCommand(verb: DomainVerb): Command {
    const takesDomain = verb !== "status";
    return defineCommand({
      path: [spec.noun, "domain", verb],
      usage: takesDomain
        ? `pbc ${spec.noun} domain ${verb} <domain> --name <name> ` +
          `[--env <name>]`
        : `pbc ${spec.noun} domain status [--name <name>] ` +
          `[--env <name>]`,
      summary: DOMAIN_SUMMARIES[verb],
      details: "Without --name/--id, a terminal offers a picker.",
      needs: takesDomain ? addressesToMutate : addresses,
      args: takesDomain ? [{ name: "domain", required: true }] : [],
      flags: {
        name: str({
          description: `Which ${spec.label}. Asked for when omitted.`,
          required: true,
        }),
        id: idFlag,
        env: envFlag,
      },
      run: async (input, ctx) => {
        const domain = takesDomain ? ctx.args[0] : undefined;
        if (takesDomain && !domain) {
          throw new CliError(
            `Usage: pbc ${spec.noun} domain <add|verify|remove> ` +
              `<domain> --name <name>`, { code: "USAGE" });
        }
        const { client, found } = await resolveOne(ctx, input, {
          needs: takesDomain ? addressesToMutate : addresses,
          args: takesDomain ? ctx.args.slice(1) : [],
        });
        const res = await client.ext(
          `/api/${spec.kind}/custom-domain/${verb}`,
          {
            [spec.idField]: found.id,
            ...(domain ? { custom_domain: domain } : {}),
          },
        );
        if (!res.ok) throw await httpError(res, `Domain ${verb}`);
        const body = await res.json().catch(() => ({})) as {
          data?: { reachable?: boolean };
        };
        emit(
          ctx.flags.json,
          body,
          verb === "status"
            ? `${found.custom_domain ?? "-"}  ${
              body.data?.reachable === true ? "reachable" : "not reachable"
            }`
            : `OK: ${verb} ${domain}.`,
        );
        return 0;
      },
    });
  }

  return {
    [`${spec.noun} ls`]: defineCommand({
      path: [spec.noun, "ls"],
      usage: `pbc ${spec.noun} ls`,
      summary: `List ${kindPlural(spec)} in a project.`,
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client, project: p } = await project(ctx);
        const resources = await client.listResources(spec.kind, {
          project: p.id,
        });
        printResult(
          resources.map(withoutAdminCredentials),
          spec.columns,
          ctx.flags.json,
        );
        return 0;
      },
    }),

    [`${spec.noun} info`]: defineCommand({
      path: [spec.noun, "info"],
      usage: `pbc ${spec.noun} info (<name>|--name <name>|--id <id>) ` +
        `[--env <name>]`,
      summary: `Show ${spec.display} details.`,
      details: "Without --name/--id, a terminal offers a picker.",
      needs: addresses,
      args: [positional],
      flags: {
        name: str({
          description: `Which ${spec.label} to show. Asked for when omitted.`,
        }),
        id: idFlag,
        env: envFlag,
      },
      run: async (input, ctx) => {
        const { found } = await resolveOne(ctx, input, { needs: addresses });
        printDetail(found, spec.fields, ctx.flags.json);
        return 0;
      },
    }),

    [`${spec.noun} rm`]: defineCommand({
      path: [spec.noun, "rm"],
      usage: `pbc ${spec.noun} rm (<name>|--name <name>|--id <id>) ` +
        `[--yes] [--env <name>]`,
      summary: `Delete a ${spec.display}.`,
      details: "Without --name/--id, a terminal offers a picker.",
      needs: addressesToMutate,
      args: [positional],
      flags: {
        name: str({
          description: `Which ${spec.label} to delete. Asked for when omitted.`,
        }),
        id: idFlag,
        env: envFlag,
      },
      run: async (input, ctx) => {
        const { client, found, environment } = await resolveOne(ctx, input, {
          needs: addressesToMutate,
        });
        if (
          !await confirm(`Delete ${spec.label} ${found.name}?`, {
            noInput: ctx.flags.noInput || ctx.flags.json,
            yes: ctx.flags.yes,
          })
        ) {
          console.error("Aborted.");
          return 0;
        }
        await client.updateResource(spec.kind, found.id, {
          status: "deleted",
        });
        const removal = await removeEnvironmentFor(
          deps.cwd(),
          environment,
          found.id,
        );
        emit(ctx.flags.json, { ok: true }, `Deleting ${found.name}.`);
        reportRemoval(removal, environment, console.error);
        return 0;
      },
    }),

    ...(spec.domains
      ? Object.fromEntries(
        (["add", "verify", "remove", "status"] as DomainVerb[]).map((verb) => [
          `${spec.noun} domain ${verb}`,
          domainCommand(verb),
        ]),
      )
      : {}),
  };
}
