import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import { CliError } from "../errors.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";

/** `users.role` values allowed to create and own an organization. */
const ORG_OWNER_ROLES = ["system_admin", "moderator"];

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
    if (!name) throw new CliError("Usage: pbc cloud org create <name>", 2);
    const { client } = await deps.requireAuth();
    // organizations.createRule is checked before any hook runs, so the platform
    // refuses this with a bare "Failed to create record." Ask who we are first
    // and say the actual reason. Being *invited* into an org is open to
    // everyone — only starting one is staff-only.
    const me = await client.whoami();
    if (!ORG_OWNER_ROLES.includes(me.role ?? "")) {
      throw new CliError(
        "Creating an organization is limited to platform staff accounts. " +
          "Ask an organization owner to invite you instead.",
        3,
      );
    }
    const o = await client.createOrg(name);
    console.log(
      ctx.flags.json ? JSON.stringify(o) : `Created org ${o.name} (${o.id}).`,
    );
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const id = ctx.args[0];
    if (!id) throw new CliError("Usage: pbc cloud org rm <orgId>", 2);
    const { client } = await deps.requireAuth();
    if (
      !await confirm(`Delete org ${id}?`, {
        noInput: ctx.flags.noInput || ctx.flags.json,
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
    // `org share` takes --org, so accept it here too: one noun, one convention.
    const orgId = ctx.args[0] ?? (ctx.raw.org as string | undefined);
    if (!orgId) {
      throw new CliError("Usage: pbc cloud org members ls <orgId>", 2);
    }
    const { client } = await deps.requireAuth();
    const members = await client.listMembers(orgId);
    // The owner is not a row in org_members, so a healthy org with no invited
    // developers printed an empty table — indistinguishable from a failed call.
    const org = (await client.listOrgs()).find((o) => o.id === orgId);
    const rows =
      org?.role === "owner" && !members.some((m) => m.role === "owner")
        ? [{ email: (await client.whoami()).email, role: "owner" }, ...members]
        : members;
    printResult(rows, [
      { header: "EMAIL", get: (m) => m.email },
      { header: "ROLE", get: (m) => m.role },
    ], ctx.flags.json);
    return 0;
  };

  const membersAdd: Handler = async (ctx: CmdCtx) => {
    const flagOrg = ctx.raw.org as string | undefined;
    const [a, b] = ctx.args;
    const orgId = flagOrg ?? a;
    const email = flagOrg ? a : b;
    if (!orgId || !email) {
      throw new CliError(
        "Usage: pbc cloud org members add <orgId> <email>  (or --org <id> <email>)",
        2,
      );
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
    const flagOrg = ctx.raw.org as string | undefined;
    const [a, b] = ctx.args;
    const orgId = flagOrg ?? a;
    const email = flagOrg ? a : b;
    if (!orgId || !email) {
      throw new CliError(
        "Usage: pbc cloud org members rm <orgId> <email>  (or --org <id> <email>)",
        2,
      );
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
        "Usage: pbc cloud org share <project> --org <id> | --none",
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
