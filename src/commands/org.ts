import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { CliError } from "../errors.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";

export function makeOrgCommands(deps: CloudCmdDeps): Record<string, Handler> {
  const ls: Handler = async (ctx: CmdCtx) => {
    const { client } = await deps.requireAuth();
    printResult(await client.listOrgs(), [
      { header: "ID", get: (o) => o.id },
      { header: "NAME", get: (o) => o.name },
      { header: "ROLE", get: (o) => o.role },
    ], ctx.flags.json);
    return 0;
  };

  const create: Handler = async (ctx: CmdCtx) => {
    const name = ctx.args[0];
    if (!name) throw new CliError("Usage: pb cloud org create <name>", 2);
    const { client } = await deps.requireAuth();
    const o = await client.createOrg(name);
    console.log(
      ctx.flags.json ? JSON.stringify(o) : `Created org ${o.name} (${o.id}).`,
    );
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const id = ctx.args[0];
    if (!id) throw new CliError("Usage: pb cloud org rm <orgId>", 2);
    const { client } = await deps.requireAuth();
    if (
      !await confirm(`Delete org ${id}?`, {
        noInput: ctx.flags.noInput,
        yes: ctx.flags.yes,
      })
    ) {
      console.log("Aborted.");
      return 0;
    }
    await client.deleteOrg(id);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleted org ${id}.`,
    );
    return 0;
  };

  const membersLs: Handler = async (ctx: CmdCtx) => {
    const orgId = ctx.args[0];
    if (!orgId) {
      throw new CliError("Usage: pb cloud org members ls <orgId>", 2);
    }
    const { client } = await deps.requireAuth();
    printResult(await client.listMembers(orgId), [
      { header: "EMAIL", get: (m) => m.email },
      { header: "ROLE", get: (m) => m.role },
    ], ctx.flags.json);
    return 0;
  };

  const membersAdd: Handler = async (ctx: CmdCtx) => {
    const [orgId, email] = ctx.args;
    if (!orgId || !email) {
      throw new CliError("Usage: pb cloud org members add <orgId> <email>", 2);
    }
    const { client } = await deps.requireAuth();
    await client.addMember(orgId, email);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ ok: true })
        : `Added ${email} as developer.`,
    );
    return 0;
  };

  const membersRm: Handler = async (ctx: CmdCtx) => {
    const [orgId, email] = ctx.args;
    if (!orgId || !email) {
      throw new CliError("Usage: pb cloud org members rm <orgId> <email>", 2);
    }
    const { client } = await deps.requireAuth();
    await client.removeMember(orgId, email);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Removed ${email}.`,
    );
    return 0;
  };

  const share: Handler = async (ctx: CmdCtx) => {
    const token = ctx.args[0];
    if (!token) {
      throw new CliError(
        "Usage: pb cloud org share <project> --org <id> | --none",
        2,
      );
    }
    const { client, config } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: token,
      noInput: true,
    });
    const none = ctx.raw.none === true;
    const orgId = ctx.raw.org as string | undefined;
    if (!none && !orgId) throw new CliError("Pass --org <id> or --none.", 2);
    await client.shareProject(p.id, none ? null : orgId!);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ ok: true })
        : none
        ? `Unshared ${p.name}.`
        : `Shared ${p.name} to ${orgId}.`,
    );
    return 0;
  };

  return {
    "cloud org ls": ls,
    "cloud org create": create,
    "cloud org rm": rm,
    "cloud org members ls": membersLs,
    "cloud org members add": membersAdd,
    "cloud org members rm": membersRm,
    "cloud org share": share,
  };
}
