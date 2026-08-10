import { join } from "@std/path";
import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError } from "../errors.ts";
import { printDetail, printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";
import type { BuildConfig } from "../config.ts";
import {
  readOwnPbJson,
  removeEnvironment,
  removeEnvironmentFor,
  upsertEnvironment,
} from "../config.ts";
import { FALLBACK_VERSIONS, resolveLatest } from "../local/releases.ts";
import {
  attachZip,
  awaitDeployment,
  awaitReachable,
  buildBundle,
  computeChooser,
  computeFlag,
  deployProgress,
  deployResource,
  ensureTarget,
  envFileEntry,
  pushEnvFile,
  reportUrl,
  resolveAdminCredentials,
  resolveEnvFile,
  resolveExisting,
  resolveOwnerId,
  resolveTarget,
  uploadLabel,
} from "./deploy-helper.ts";
import { reportRemoval } from "./environments.ts";

/**
 * What the platform accepts as a hook file. Mirrors `ALLOWED_EXTENSIONS` in
 * `backend-extension/src/dto/hook.dto.ts` — keep the two in step. PocketBase
 * itself only auto-loads `*.pb.js`, but a hook routinely `require()`s a plain
 * `.js` helper or a `.json` data file beside it, and those have to travel too
 * or the hook that needs them breaks on the instance.
 */
const HOOK_EXTENSIONS = [".js", ".json"];

/**
 * How many hook files one push may carry.
 *
 * Deliberately *below* the platform's own ceiling of 50
 * (`validateBulkWriteHooksInput` in `server-agent/src/dto/hook.dto.ts`): a
 * pb_hooks directory this large is nearly always a wrong `--name` or a
 * directory that is not pb_hooks at all, and catching that here beats
 * uploading it. This is a CLI guard rail, not a platform rule — the portal and
 * a direct API call still write up to 50.
 */
const MAX_HOOKS_PER_PUSH = 30;

/**
 * Uploads every hook file in `dir`. Shared by `hooks push` and by `deploy`'s
 * redeploy path: hooks are stored in the platform's database (so the portal's
 * editor stays in sync) and therefore never travel in the deploy archive,
 * which carries pb_public and pb_migrations only.
 *
 * `sent` and `stored` are separate because they fail differently: `sent: 0`
 * means the directory held nothing uploadable, while `sent: 3, stored: 2`
 * means the platform refused a file. Collapsing them into one count reports
 * the second case as the first.
 *
 * Hooks belong to one PocketBase instance, not to the project: `pocketbaseId`
 * is the instance record's id.
 *
 * Anything left behind is reported through `log`. Silently dropping a file is
 * the bug this function was rewritten to fix — a skipped `helpers.js` surfaces
 * much later as a `require` error inside the running instance, with nothing in
 * the deploy output to connect the two.
 */
export async function pushHooks(
  client: ICloudClient,
  pocketbaseId: string,
  dir: string,
  log: (msg: string) => void = () => {},
): Promise<{ sent: number; stored: number }> {
  const names: string[] = [];
  const subdirs: string[] = [];
  // Only the listing is guarded: folding the file reads into this try would
  // report an unreadable hook file as a missing directory.
  try {
    for await (const entry of Deno.readDir(dir)) {
      // The platform stores hooks as flat files: validateHookFilename() in the
      // agent rejects a name holding "/" or "\", so nothing under a
      // subdirectory has a route to the instance. Say so rather than descend.
      if (entry.isDirectory) {
        subdirs.push(entry.name);
        continue;
      }
      if (!entry.isFile) continue;
      if (!HOOK_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      names.push(entry.name);
    }
  } catch {
    throw new CliError(`Hooks directory not found: ${dir}`, 2);
  }
  for (const name of subdirs) {
    log(
      `Skipped ${name}/ — the platform stores hooks as flat files, so ` +
        `subdirectories are not uploaded.`,
    );
  }
  if (names.length === 0) return { sent: 0, stored: 0 };
  // Before the files are read, not after: the batch is already refused, so
  // reading it would be work thrown away.
  if (names.length > MAX_HOOKS_PER_PUSH) {
    // Names the directory, because the usual cause is that it is not the one
    // the user meant — a bare `pb cloud pb hooks push .` in a project root
    // lands here rather than uploading the repository.
    throw new CliError(
      `${names.length} hook files in ${dir} — pb pushes at most ` +
        `${MAX_HOOKS_PER_PUSH} at a time. Check that this is your pb_hooks ` +
        `directory.`,
      2,
    );
  }
  const hooks: { filename: string; content: string; active: boolean }[] = [];
  for (const filename of names) {
    hooks.push({
      filename,
      content: await Deno.readTextFile(join(dir, filename)),
      // Sent explicitly: the service treats a missing `active` as active when
      // deciding what to write to the server, but records it verbatim, so an
      // omitted flag lands in the database as false and the portal then shows
      // a live hook as disabled.
      active: true,
    });
  }
  // Service-key-guarded on backend-extension, so it goes through PocketBase.
  const res = await client.pbApi("/api/hooks/bulk-write", {
    pocketbase_id: pocketbaseId,
    hooks,
  });
  if (!res.ok) throw new CliError(`Hook push failed (${res.status}).`, 1);
  return {
    sent: hooks.length,
    stored: await reportHookResults(res, hooks.length, log),
  };
}

/**
 * Reads the per-file outcome out of a bulk-write response and returns how many
 * files the platform actually stored. A 200 only means the batch was accepted:
 * `details.results[]` can still carry individual failures, and counting the
 * files we sent instead of the ones that landed reports a push that partly
 * failed as a complete one.
 */
async function reportHookResults(
  res: Response,
  sent: number,
  log: (msg: string) => void,
): Promise<number> {
  let body: {
    details?: {
      succeeded?: number;
      results?: { filename: string; status: string; error_message?: string }[];
    };
  };
  try {
    body = await res.json();
  } catch {
    // An unreadable body is not a failed push — the write already succeeded.
    return sent;
  }
  const failures = (body.details?.results ?? []).filter((r) =>
    r.status === "failed"
  );
  for (const f of failures) {
    log(`Hook rejected: ${f.filename} — ${f.error_message ?? "unknown error"}`);
  }
  return typeof body.details?.succeeded === "number"
    ? body.details.succeeded
    : sent - failures.length;
}

/**
 * The PocketBase build the new instance is created with. Never returns an
 * empty string: the platform hands `version` straight to the server agent, and
 * an empty one leaves the instance stranded in `creating` with no error status
 * ever written — a silent, unrecoverable deploy.
 *
 * Order: an explicit --pb-version, then the directory's pin (the version it was
 * developed against), then the newest published release. If the releases API
 * cannot be reached, the newest built-in version stands in rather than letting
 * a network hiccup produce an unprovisionable instance.
 */
async function resolveDeployVersion(
  flagVersion: string | undefined,
  cwd: string,
  deps: CloudCmdDeps,
): Promise<string> {
  const pinned = flagVersion ?? (await readOwnPbJson(cwd)).pocketbaseVersion;
  if (pinned) return pinned;
  try {
    return await resolveLatest({
      fetch: deps.fetch ?? globalThis.fetch,
      env: deps.env ?? ((k) => Deno.env.get(k)),
    });
  } catch {
    return FALLBACK_VERSIONS[0];
  }
}

export function makePbCommands(deps: CloudCmdDeps): Record<string, Handler> {
  async function project(ctx: CmdCtx) {
    const { client, config, auth } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput || ctx.flags.json,
    });
    return { client, project: p, auth };
  }

  const deploy: Handler = async (ctx: CmdCtx) => {
    const progress = deployProgress(ctx.flags.json);
    const { client, project: p, auth } = await progress.step(
      "Connecting to PocketBase Cloud",
      () => project(ctx),
    );
    const cwd = deps.cwd();
    const name = (ctx.raw.name as string) ?? ctx.args[0];
    const id = ctx.raw.id as string | undefined;
    const target = await ensureTarget(
      await resolveTarget({ id, name }, "pocketbases", cwd, {
        envFlag: ctx.raw.env as string | undefined,
        allowNewEnvironment: true,
        strictKind: true,
        askEnvironment: { noInput: ctx.flags.noInput || ctx.flags.json },
      }),
      {
        label: "PocketBase",
        cwd,
        list: () => client.listResources("pocketbases", p.id),
        noInput: ctx.flags.noInput || ctx.flags.json,
      },
    );
    const log = (m: string) => progress.log(m);
    const zipPath = ctx.raw.zip as string | undefined;
    const data: Record<string, unknown> = { project: p.id };
    if (target.name) data.name = target.name;
    if (ctx.raw.location) data.location = ctx.raw.location;
    // A Pro account's dedicated compute is `ownership: "user"`, which the
    // platform's auto-selection (platform pool only) never picks — so a Pro (or
    // organization) deploy names it, exactly as the portal's create page does.
    // Unset, the compute is chosen on the create path below.
    const compute = computeFlag(ctx.raw);
    if (compute) data.server = compute;
    const askCompute = computeChooser(client, p.id, {
      noInput: ctx.flags.noInput || ctx.flags.json,
      log,
    });

    // Packaged on both paths: a new instance extracts the archive when it is
    // created, and an existing one has it installed by the platform's
    // upload-files route.
    const bundle = await buildBundle({
      cwd,
      kind: "pocketbases",
      zipPath,
      skipBuild: ctx.raw["skip-build"] === true,
      envFile: ctx.raw["env-file"] as string | undefined,
      environment: target.environment,
      log,
      progress,
    });
    const build: BuildConfig = bundle.build;
    // Resolved here, beside the packaging, so a named-but-missing env file
    // fails before anything is provisioned rather than after.
    const env = await resolveEnvFile({
      cwd,
      build,
      environment: target.environment,
      flag: ctx.raw["env-file"] as string | undefined,
      skip: ctx.raw["skip-env"] === true,
      noInput: ctx.flags.noInput || ctx.flags.json,
    });
    // The upload route installs pb_public and pb_migrations only — pb_hooks go
    // through the hooks route, so an archive holding nothing else must not be
    // sent: the platform would reject it and mark the instance errored.
    const hasUploadableDirs = Boolean(
      zipPath ?? build.pbPublic ?? build.pbMigrations,
    );
    const updateData: Record<string, unknown> = {};
    if (hasUploadableDirs) {
      attachZip(updateData, bundle);
      // pocketbase.service.ts only installs an archive on a record whose
      // status says a new one is waiting.
      updateData.status = "uploading";
    }

    let credentials: { adminUsername: string; adminPassword: string } | null =
      null;
    // The archive travels inside this call. With no pb_public/pb_migrations to
    // send there is nothing to weigh, so the step says what it is really doing.
    const { resource, created } = await progress.step(
      hasUploadableDirs ? uploadLabel(bundle) : "Sending the deploy request",
      () =>
        deployResource(
          client,
          "pocketbases",
          p.id,
          {
            id: target.id,
            name: target.name,
            data,
            updateData,
            createData: async () => {
              credentials = await resolveAdminCredentials(client, {
                username: ctx.raw["admin-email"] as string | undefined,
                password: ctx.raw["admin-password"] as string | undefined,
              });
              const extra: Record<string, unknown> = {
                user: await resolveOwnerId(client, auth),
                status: "creating",
                ...credentials,
              };
              // Only on create, and only lazily: a redeploy must never move a
              // running instance to another compute, and asking costs a
              // request.
              if (!data.server) {
                const picked = await askCompute();
                if (picked) extra.server = picked;
              }
              // Which PocketBase build the agent installs. The directory's pin
              // is the right default: it is the version already developed
              // against.
              extra.version = await resolveDeployVersion(
                ctx.raw["pb-version"] as string | undefined,
                cwd,
                deps,
              );
              attachZip(extra, bundle);
              return extra;
            },
            requireExisting: target.fromBinding,
            environment: target.environment,
            onStale: async () => {
              await removeEnvironment(cwd, target.environment);
            },
          },
        ),
    );
    await upsertEnvironment(cwd, {
      projectId: p.id,
      kind: "pocketbases",
      environment: target.environment,
      entry: {
        id: resource.id,
        name: resource.name,
        ...await envFileEntry(cwd, target.environment, env, log),
      },
    });

    if (!created) {
      // Bound outside the step callback: narrowing an optional property does
      // not survive into a closure, since nothing stops `build` being mutated
      // in between.
      const hooksDir = build.pbHooks;
      if (hooksDir) {
        await progress.step("Pushing hook files", async () => {
          const { stored } = await pushHooks(
            client,
            resource.id,
            join(cwd, hooksDir),
            log,
          );
          log(`Pushed ${stored} hook file(s).`);
        });
      }
      log(
        hasUploadableDirs
          ? "Uploaded the archive: pb_migrations is merged into the instance " +
            "and pb_public replaced. New migrations run on the restart that " +
            "follows."
          : "Note: no pb_public or pb_migrations directory to upload — only " +
            "hooks were pushed.",
      );
    }

    if (env.push) {
      await pushEnvFile(client, {
        targetId: resource.id,
        type: "pocketbase",
        name: env.push.name,
        vars: env.push.vars,
        deleteMissing: ctx.raw["delete-missing"] === true,
        force: ctx.raw["force-env"] === true,
        statePath: deps.envStatePath?.(),
        log,
        progress,
      });
    }
    const final = await awaitDeployment(client, "pocketbases", resource, {
      progress,
      created,
      environment: target.environment,
      label: "PocketBase",
      checkCommand: "pb",
    });
    // The admin account exists only on the new instance, so a generated
    // password has to be shown once — `pb cloud pb info` can recover it later.
    const admin = credentials as
      | { adminUsername: string; adminPassword: string }
      | null;
    // Both URLs: the instance itself, and the dashboard a user would otherwise
    // have to know to append /_/ to.
    if (final.status === "running") {
      reportUrl(final, { log, paths: [{ path: "/_/", label: "admin" }] });
    }
    const reachable = created && final.status === "running"
      ? await awaitReachable(client, {
        type: "pocketbase",
        resource: final,
        log,
        progress,
      })
      : undefined;
    if (ctx.flags.json) {
      console.log(JSON.stringify({
        ...final,
        environment: target.environment,
        ...(reachable === undefined ? {} : { reachable }),
        ...(admin ?? {}),
      }));
    }
    if (!ctx.flags.json && admin) {
      console.log(
        `Admin login: ${admin.adminUsername} / ${admin.adminPassword}`,
      );
    }
    return final.status === "running" ? 0 : 6;
  };

  const ls: Handler = async (ctx: CmdCtx) => {
    const { client, project: p } = await project(ctx);
    const rows = await client.listResources("pocketbases", p.id);
    printResult(rows, [
      { header: "ID", get: (r) => r.id },
      { header: "NAME", get: (r) => r.name },
      { header: "STATUS", get: (r) => r.status },
      { header: "DOMAIN", get: (r) => r.domain ?? r.subdomain ?? "-" },
      { header: "CREATED BY", get: (r) => r.createdBy },
    ], ctx.flags.json);
    return 0;
  };

  async function resolveOne(ctx: CmdCtx) {
    const { client, project: p } = await project(ctx);
    const base = {
      id: ctx.raw.id as string | undefined,
      name: (ctx.raw.name as string) ?? ctx.args[0],
    };
    const target = await resolveTarget(base, "pocketbases", deps.cwd(), {
      envFlag: ctx.raw.env as string | undefined,
    });
    const found = await resolveExisting(
      await client.listResources("pocketbases", p.id),
      { id: target.id, name: target.name },
      {
        label: "PocketBase",
        interactive: ctx.flags.interactive,
        noInput: ctx.flags.noInput,
      },
    );
    return { client, found, environment: target.environment };
  }

  const info: Handler = async (ctx: CmdCtx) => {
    const { found } = await resolveOne(ctx);
    const r = found as unknown as Record<string, string>;
    printDetail(found, [
      { label: "NAME", get: () => r.name },
      { label: "ID", get: () => r.id },
      { label: "STATUS", get: () => r.status },
      { label: "URL", get: () => r.baseUrl },
      { label: "VERSION", get: () => r.version },
      { label: "COMPUTE", get: () => r.server },
      { label: "PROJECT", get: () => r.project },
      { label: "ADMIN", get: () => r.adminUsername },
      { label: "PASSWORD", get: () => r.adminPassword },
      { label: "CREATED", get: () => r.created },
    ], ctx.flags.json);
    return 0;
  };

  const rm: Handler = async (ctx: CmdCtx) => {
    const { client, found, environment } = await resolveOne(ctx);
    if (
      !await confirm(`Delete PocketBase ${found.name}?`, {
        noInput: ctx.flags.noInput || ctx.flags.json,
        yes: ctx.flags.yes,
      })
    ) {
      console.log("Aborted.");
      return 0;
    }
    // Deletion is an update to status="deleted", which triggers teardown via hooks.
    await client.updateResource("pocketbases", found.id, { status: "deleted" });
    const removal = await removeEnvironmentFor(
      deps.cwd(),
      environment,
      found.id,
    );
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleting ${found.name}.`,
    );
    if (!ctx.flags.json) reportRemoval(removal, environment, console.log);
    return 0;
  };

  const hooksPush: Handler = async (ctx: CmdCtx) => {
    const dir = ctx.args[0];
    if (!dir) throw new CliError("Usage: pb cloud pb hooks push <dir>", 2);
    // Hooks live on one instance, so resolve which — by --name/--id, or the
    // environment this directory is bound to.
    const { client, found } = await resolveOne({
      ...ctx,
      args: ctx.args.slice(1),
    });
    // Skip/rejection notices would corrupt the machine-readable output, so
    // under --json they are dropped the way the deploy path drops its own.
    const log = ctx.flags.json ? () => {} : (m: string) => console.log(m);
    const { sent, stored } = await pushHooks(client, found.id, dir, log);
    if (sent === 0) {
      throw new CliError(
        `No ${HOOK_EXTENSIONS.join(" or ")} files in ${dir}.`,
        2,
      );
    }
    console.log(
      ctx.flags.json
        ? JSON.stringify({ pushed: stored })
        : `Pushed ${stored} hook file(s).`,
    );
    return 0;
  };

  const hooksLs: Handler = async (ctx: CmdCtx) => {
    const { client, found } = await resolveOne(ctx);
    const res = await client.pbApi("/api/hooks", undefined, {
      method: "GET",
      query: { pocketbase_id: found.id },
    });
    if (!res.ok) throw new CliError(`Hook list failed (${res.status}).`, 1);
    const body = await res.json() as {
      hooks?: { filename: string; active?: boolean; updated?: string }[];
    };
    // The API answers with a {hooks, success, total} envelope; printing it raw
    // made --json indistinguishable from the default output.
    printResult(body.hooks ?? [], [
      { header: "FILENAME", get: (h) => h.filename },
      { header: "ACTIVE", get: (h) => h.active === false ? "" : "yes" },
      { header: "UPDATED", get: (h) => h.updated ?? "" },
    ], ctx.flags.json);
    return 0;
  };

  const hooksRm: Handler = async (ctx: CmdCtx) => {
    const filename = ctx.args[0];
    if (!filename) {
      throw new CliError("Usage: pb cloud pb hooks rm <filename>", 2);
    }
    const { client, found } = await resolveOne({
      ...ctx,
      args: ctx.args.slice(1),
    });
    const res = await client.pbApi("/api/hooks/delete", {
      pocketbase_id: found.id,
      hook_filename: filename,
    });
    if (!res.ok) throw new CliError(`Hook delete failed (${res.status}).`, 1);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleted ${filename}.`,
    );
    return 0;
  };

  return {
    "cloud pb deploy": deploy,
    "cloud pb ls": ls,
    "cloud pb info": info,
    "cloud pb rm": rm,
    "cloud pb hooks push": hooksPush,
    "cloud pb hooks ls": hooksLs,
    "cloud pb hooks rm": hooksRm,
  };
}
