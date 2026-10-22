import {
  bool,
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
import { kindPlural, type KindSpec } from "../kinds.ts";
import { CliError, httpError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { printDetail, printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";
import { resolveResourceTarget } from "../resolve/target.ts";
import { type CloudAuth, removeEnvironmentFor } from "../config.ts";
import { reportRemoval } from "./environments.ts";
import {
  type DeploymentRow,
  getDeployment,
  listDeployments,
  requestRollback,
  waitForDeployment,
} from "../clients/deployments.ts";
import type { Column } from "../ui/output.ts";
import { repositoryLine } from "../clients/repo-link.ts";

const DOMAIN_SUMMARIES = {
  add: "Add a custom domain.",
  verify: "Verify a custom domain.",
  remove: "Remove a custom domain.",
  status: "Check whether the custom domain is reachable.",
} as const;

type DomainVerb = keyof typeof DOMAIN_SUMMARIES;

const ACCESS_SUMMARIES = {
  status: "Show whether it is private and who can open it.",
  private: "Make it private. Emails given replace the list.",
  public: "Make it public. The list is kept.",
  add: "Add emails or @domains to the list.",
  remove: "Remove emails or @domains from the list.",
} as const;

type AccessVerb = keyof typeof ACCESS_SUMMARIES;

const ACCESS_VERBS_WITH_EMAILS: readonly AccessVerb[] = ["add", "remove"];

function nextAccess(
  verb: Exclude<AccessVerb, "status">,
  current: { private: boolean; emails: string[] },
  given: string[],
): { private: boolean; emails: string[] } {
  const normalized = given.flatMap((arg) => arg.split(","))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  switch (verb) {
    case "private":
      return {
        private: true,
        emails: normalized.length > 0
          ? [...new Set(normalized)]
          : current.emails,
      };
    case "public":
      return { private: false, emails: current.emails };
    case "add":
      return {
        private: current.private,
        emails: [...new Set([...current.emails, ...normalized])],
      };
    case "remove":
      return {
        private: current.private,
        emails: current.emails.filter((e) => !normalized.includes(e)),
      };
  }
}

function withoutAdminCredentials(resource: Resource): Resource {
  const listed = { ...resource } as Resource & {
    adminUsername?: unknown;
    adminPassword?: unknown;
  };
  delete listed.adminUsername;
  delete listed.adminPassword;
  return listed;
}

const SUCCESS = "success";
const SHORT_SHA = 7;

type ListedDeployment = DeploymentRow & { live: boolean; by: string };

const DEPLOYMENT_COLUMNS: Column<ListedDeployment>[] = [
  { header: "ID", get: (d) => d.id },
  { header: "STATUS", get: (d) => d.live ? "live" : d.status },
  { header: "CREATED", get: (d) => d.created },
  { header: "BY", get: (d) => d.by },
  { header: "COMMIT", get: (d) => d.gitSha?.slice(0, SHORT_SHA) || "-" },
  { header: "REVISION", get: (d) => revisionOf(d)?.toString() ?? "-" },
  {
    header: "NOTE",
    get: (d) =>
      d.metadata?.rollbackOf
        ? `rollback to ${d.metadata.rollbackOf}`
        : d.status === "failed"
        ? d.statusMessage || ""
        : d.gitTitle || d.metadata?.message || "",
  },
];

function revisionOf(d: DeploymentRow): number | undefined {
  return typeof d.metadata?.revision === "number"
    ? d.metadata.revision
    : undefined;
}

export function deployedBy(d: DeploymentRow, me: string): string {
  if (d.requestedBy) return d.requestedBy === me ? "you" : "a teammate";
  return d.gitAuthor || (d.gitSha ? "GitHub" : "-");
}

function liveDeployment(rows: DeploymentRow[]): DeploymentRow | undefined {
  return rows.find((d) => d.status === SUCCESS);
}

function describeDeployment(d: DeploymentRow): string {
  const commit = d.gitSha ? `, commit ${d.gitSha.slice(0, SHORT_SHA)}` : "";
  const revision = revisionOf(d);
  const title = d.gitTitle || d.metadata?.message;
  return `${d.id} (${d.created}${commit}${
    revision === undefined ? "" : `, revision #${revision}`
  })${title ? ` "${title}"` : ""}`;
}

export type ResourceResolver = {
  resolveOne: (
    ctx: CmdCtx,
    input: { name?: string; id?: string; env?: string },
    opts?: { needs?: readonly Need[]; args?: string[] },
  ) => Promise<
    {
      client: ICloudClient;
      auth: CloudAuth;
      found: Resource;
      environment: string;
    }
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
    const { client, config, auth } = await deps.requireAuth();
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
    return { client, auth, found: resource, environment };
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
              `<domain> --name <name>`,
            { code: "USAGE" },
          );
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

  function accessCommand(verb: AccessVerb): Command {
    const needs = verb === "status" ? addresses : addressesToMutate;
    const takesEmails = verb !== "status" && verb !== "public";
    const emailsRequired = ACCESS_VERBS_WITH_EMAILS.includes(verb);
    return defineCommand({
      path: [spec.noun, "access", verb],
      usage: `pbc ${spec.noun} access ${verb}` +
        (takesEmails ? (emailsRequired ? " <emails>" : " [emails]") : "") +
        ` [--name <name>] [--env <name>]`,
      summary: ACCESS_SUMMARIES[verb],
      needs,
      args: takesEmails ? [{ name: "email", required: emailsRequired }] : [],
      flags: {
        name: str({
          description: `Which ${spec.label}. Asked for when omitted.`,
        }),
        id: idFlag,
        env: envFlag,
      },
      run: async (input, ctx) => {
        if (emailsRequired && ctx.args.length === 0) {
          throw new CliError(
            `Usage: pbc ${spec.noun} access ${verb} <emails> --name <name>`,
            { code: "USAGE" },
          );
        }
        const { client, found } = await resolveOne(ctx, input, {
          needs,
          args: [],
        });
        const current = {
          private: found.access === "private",
          emails: found.accessEmails ?? [],
        };
        if (verb === "status") {
          emit(
            ctx.flags.json,
            current,
            current.private
              ? `${found.name} is private. Project members and:\n` +
                (current.emails.length > 0
                  ? current.emails.map((e) => `  ${e}`).join("\n")
                  : "  (nobody else)")
              : `${found.name} is public.`,
          );
          return 0;
        }
        const next = nextAccess(verb, current, takesEmails ? ctx.args : []);
        const res = await client.ext(
          `/api/access/${spec.noun}/${found.id}`,
          next,
        );
        if (!res.ok) throw await httpError(res, `Access ${verb}`);
        emit(
          ctx.flags.json,
          next,
          `OK: ${found.name} is ${next.private ? "private" : "public"}` +
            ` (${next.emails.length} email${
              next.emails.length === 1 ? "" : "s"
            } listed).`,
        );
        return 0;
      },
    });
  }

  async function rollbackTarget(
    client: ICloudClient,
    found: Resource,
    rows: DeploymentRow[],
    to: string | undefined,
  ): Promise<DeploymentRow> {
    if (to) {
      const chosen = rows.find((d) => d.id === to) ??
        await getDeployment(client, to);
      if (chosen.resourceId !== found.id) {
        throw new CliError(
          `Deployment ${to} does not belong to ${spec.label} ${found.name}.`,
          { code: "INVALID_VALUE" },
        );
      }
      return chosen;
    }
    const live = liveDeployment(rows)?.id;
    const previous = rows.find((d) =>
      d.status === SUCCESS && d.id !== live &&
      (spec.kind !== "pocketbases" || revisionOf(d) !== undefined)
    );
    if (!previous) {
      throw new CliError(
        `${found.name} has no earlier successful deployment to roll back to.`,
        { code: "NOT_FOUND" },
      );
    }
    return previous;
  }

  function rollbackCommands(): Record<string, Command> {
    const envNote = spec.kind === "backends"
      ? " Environment variables stay as they are; only the code goes back."
      : spec.kind === "pocketbases"
      ? " The hooks, migrations and public files of that deployment's revision come back; data and schema are not changed."
      : "";
    const nameFlag = (verb: string) =>
      str({
        description: `Which ${spec.label} to ${verb}. Asked for when omitted.`,
      });

    return {
      [`${spec.noun} deployments`]: defineCommand({
        path: [spec.noun, "deployments"],
        usage:
          `pbc ${spec.noun} deployments [<name>|--name <name>|--id <id>] ` +
          `[--env <name>]`,
        summary: `List a ${spec.display}'s recent deployments.`,
        needs: addresses,
        args: [positional],
        flags: { name: nameFlag("list"), id: idFlag, env: envFlag },
        run: async (input, ctx) => {
          const { client, auth, found } = await resolveOne(ctx, input, {
            needs: addresses,
          });
          const rows = await listDeployments(client, found.id);
          const live = liveDeployment(rows)?.id;
          printResult(
            rows.map((d) => ({
              ...d,
              live: d.id === live,
              by: deployedBy(d, auth.userId),
            })),
            DEPLOYMENT_COLUMNS,
            ctx.flags.json,
          );
          return 0;
        },
      }),

      [`${spec.noun} rollback`]: defineCommand({
        path: [spec.noun, "rollback"],
        usage: `pbc ${spec.noun} rollback [<name>|--name <name>|--id <id>] ` +
          `[--to <deployment>] [--push-to-git] [--yes] [--env <name>]`,
        summary: `Roll a ${spec.display} back to an earlier deployment.`,
        details: "Without --to, goes back to the successful deployment " +
          "before the live one. The earlier build is deployed again as a " +
          `new deployment; list candidates with pbc ${spec.noun} deployments.` +
          " The linked GitHub repository is left alone unless --push-to-git " +
          "also puts the old source back there, so the next push keeps the " +
          "rollback." +
          envNote,
        needs: addressesToMutate,
        args: [positional],
        flags: {
          name: nameFlag("roll back"),
          id: idFlag,
          env: envFlag,
          to: str({
            description:
              "The deployment id to go back to. Defaults to the one before the live deployment.",
          }),
          "push-to-git": bool({
            description:
              "Also commit the old source to the linked GitHub branch (or open a pull request in review mode).",
          }),
        },
        run: async (input, ctx) => {
          const { client, auth, found } = await resolveOne(ctx, input, {
            needs: addressesToMutate,
          });
          const rows = await listDeployments(client, found.id);
          const target = await rollbackTarget(client, found, rows, input.to);
          if (target.id === liveDeployment(rows)?.id) {
            emit(
              ctx.flags.json,
              { deploymentId: null, rollbackOf: target.id },
              `${found.name} is already running ${target.id}.`,
            );
            return 0;
          }

          if (
            !await confirm(
              `Roll ${spec.label} ${found.name} back to ` +
                `${describeDeployment(target)}?${envNote}`,
              {
                noInput: ctx.flags.noInput || ctx.flags.json,
                yes: ctx.flags.yes,
              },
            )
          ) {
            console.error("Aborted.");
            return 0;
          }

          const { deploymentId, repository } = await requestRollback(
            client,
            target.id,
            input["push-to-git"] === true,
          );
          console.error(`Rolling ${found.name} back to ${target.id}…`);
          const repositoryNote = repositoryLine(repository, "rollback");
          if (repositoryNote) console.error(repositoryNote);
          const outcome = await waitForDeployment(deploymentId, {
            baseUrl: auth.backendUrl,
            token: auth.userToken,
            fetchFn: deps.fetch,
          });
          if (outcome.status === "failed") {
            throw new CliError(outcome.statusMessage, {
              code: "PLATFORM_ERROR",
            });
          }
          emit(
            ctx.flags.json,
            {
              deploymentId,
              rollbackOf: target.id,
              ...(repository ? { repository } : {}),
            },
            `Rolled ${found.name} back to ${target.id}.`,
          );
          return 0;
        },
      }),
    };
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

    ...(spec.rollback ? rollbackCommands() : {}),

    ...(spec.domains
      ? Object.fromEntries(
        (["add", "verify", "remove", "status"] as DomainVerb[]).map((verb) => [
          `${spec.noun} domain ${verb}`,
          domainCommand(verb),
        ]),
      )
      : {}),

    ...(spec.access
      ? Object.fromEntries(
        (Object.keys(ACCESS_SUMMARIES) as AccessVerb[]).map((verb) => [
          `${spec.noun} access ${verb}`,
          accessCommand(verb),
        ]),
      )
      : {}),
  };
}
