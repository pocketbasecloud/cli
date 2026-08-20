import { join } from "@std/path";
import type { CmdCtx, Handler } from "../router.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError, httpError } from "../errors.ts";
import { printDetail, printResult } from "../ui/output.ts";
import { canPrompt, confirm, prompt } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";
import type { BuildConfig } from "../config.ts";
import {
  readLinkFile,
  readOwnPbJson,
  removeEnvironment,
  removeEnvironmentFor,
  upsertEnvironment,
} from "../config.ts";
import {
  chooseEnvironment,
  entryFor,
  resolveEnvironmentName,
} from "../resolve/environment.ts";
import { FALLBACK_VERSIONS, resolveLatest } from "../local/releases.ts";
import { pbArchiveShape, zipEntryNames } from "../build/pb-archive.ts";
import {
  attachZip,
  awaitDeployment,
  awaitReachable,
  buildBundle,
  chooseCompute,
  computeChooser,
  computeFlag,
  deployProgress,
  deployResource,
  ensureTarget,
  envFileEntry,
  findExisting,
  pushEnvFile,
  reportUrl,
  resolveAdminCredentials,
  resolveEnvFile,
  resolveExisting,
  resolveOwnerId,
  resolveTarget,
  suggestName,
  uploadLabel,
  validateLocationChoice,
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
/**
 * Refuse nested hook files before they reach the platform.
 *
 * The agent's `validateHookFilename` rejects a name holding "/" or "\", so a
 * `.js` file inside a subdirectory of pb_hooks can never be installed. Catching
 * it here — before the archive is uploaded — means the CLI names the file and
 * the fix, rather than the platform marking the instance errored after the
 * bytes have already travelled.
 */
async function findNestedHooks(dir: string): Promise<string[]> {
  const nested: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isDirectory) continue;
      try {
        for await (const sub of Deno.readDir(join(dir, entry.name))) {
          if (!sub.isFile) continue;
          if (HOOK_EXTENSIONS.some((ext) => sub.name.endsWith(ext))) {
            nested.push(`${entry.name}/${sub.name}`);
          }
        }
      } catch { /* subdir unreadable, skip */ }
    }
  } catch {
    // Directory doesn't exist — not a validation failure, just nothing to check.
  }
  return nested;
}

const MAX_HOOKS_PER_PUSH = 30;

/**
 * How long one hook file may be.
 *
 * Mirrors the `max` on the `hook.content` field in PocketBase — keep the two in
 * step; the platform is authoritative and its own message quotes the real
 * number, which is why exceeding this is worth catching but not worth guessing
 * about.
 *
 * The reason to check it *here* rather than let the platform refuse: a push
 * sends `active: true`, so the agent writes the file to the running instance
 * before the database is touched. The agent's own ceiling is 1MB, so a file
 * between the two limits lands on the instance and *then* fails to be stored —
 * leaving the hook live on the server while the portal editor and `hooks ls`
 * still show the previous version, and the next save quietly ships that stale
 * copy back over it. Refusing before the request keeps the two in agreement.
 */
const MAX_HOOK_CONTENT_CHARS = 300_000;

/** `123456` → `123,456`. A five-figure limit is unreadable without it. */
function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Refuses a `--zip` archive the platform's upload route would reject anyway.
 *
 * Only reachable on a **redeploy**: creating an instance extracts the archive
 * wholesale, so anything in it lands somewhere, while the upload route installs
 * `pb_hooks`, `pb_migrations` and `pb_public` and skips the rest. Without this
 * the archive travels to the VM, is refused there, and a healthy running
 * instance is marked errored for a mistake that was visible before the upload
 * began. Naming what the archive *does* hold is the part that makes it a
 * diagnosis: the usual cause is zipping a folder's contents instead of the
 * folder.
 */
function assertUploadableArchive(bytes: Uint8Array, fileName: string): void {
  const names = zipEntryNames(bytes);
  if (names === null) {
    throw new CliError(`${fileName} is not a zip archive.`, 2);
  }

  const { uploadable, found } = pbArchiveShape(names);
  if (uploadable.length > 0) return;

  const holds = found.length === 0
    ? "it is empty"
    : `it holds ${found.slice(0, 5).join(", ")}${
      found.length > 5 ? `, and ${found.length - 5} more` : ""
    }`;
  throw new CliError(
    `${fileName} has no pb_hooks, pb_migrations or pb_public directory at ` +
      `its root — ${holds}. Those are the only directories an upload ` +
      `installs. If you zipped the contents of a folder, zip the folder ` +
      `itself instead.`,
    2,
  );
}

/**
 * Said when a deploy found no `pb_public`, `pb_hooks` or `pb_migrations` to
 * ship.
 *
 * Deploying a bare instance is supported and is not an error, so this is a
 * note rather than a failure — but it must be said. A deploy that packaged
 * nothing looks exactly like a successful one from the outside, and the usual
 * cause is being one directory up from the project, or a `pb.json` whose build
 * block points somewhere the files are not. Staying quiet lets someone watch
 * "deployed" scroll past and wonder later why the instance is empty.
 */
function nothingToDeployNote(cwd: string, created: boolean): string {
  return `Note: nothing to deploy from ${cwd} — no pb_public, pb_hooks or ` +
    `pb_migrations directory was found, so ${
      created
        ? "the instance was created bare"
        : "no files were sent and the instance is unchanged"
    }. Add one of those directories, or point build.pbPublic / build.pbHooks ` +
    `/ build.pbMigrations in pb.json at where yours live, then deploy again.`;
}

/**
 * Uploads every hook file in `dir`, for `hooks push`.
 *
 * `deploy` no longer calls this: `pb_hooks` travels in the deploy archive, and
 * the platform installs it through this same route on the far side — so
 * pushing here as well would write every file twice and restart the instance
 * twice. This remains the way to push hooks *without* deploying anything else.
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
  const oversized: string[] = [];
  for (const filename of names) {
    const content = await Deno.readTextFile(join(dir, filename));
    if (content.length > MAX_HOOK_CONTENT_CHARS) {
      oversized.push(
        `${filename} (${formatCount(content.length)} characters)`,
      );
      continue;
    }
    hooks.push({
      filename,
      content,
      // Sent explicitly: the service treats a missing `active` as active when
      // deciding what to write to the server, but records it verbatim, so an
      // omitted flag lands in the database as false and the portal then shows
      // a live hook as disabled.
      active: true,
    });
  }
  // The whole push is refused, not just the offending file: a partial push
  // leaves the instance running some files from this version and some from
  // the last, which is harder to reason about than not having pushed at all.
  if (oversized.length > 0) {
    throw new CliError(
      `${oversized.join(", ")} — a hook file may be at most ` +
        `${formatCount(MAX_HOOK_CONTENT_CHARS)} characters. Split it up and ` +
        `require() the parts.`,
      2,
    );
  }
  // Service-key-guarded on backend-extension, so it goes through PocketBase.
  const res = await client.pbApi("/api/hooks/bulk-write", {
    pocketbase_id: pocketbaseId,
    hooks,
  });
  if (!res.ok) throw await httpError(res, "Hook push");
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
  async function project(ctx: CmdCtx, log?: (m: string) => void) {
    const { client, config, auth } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput || ctx.flags.json,
      log: log ?? (ctx.flags.json ? undefined : (m) => console.log(m)),
    });
    return { client, project: p, auth };
  }

  /**
   * What to call an instance that does not exist yet, for `create`.
   *
   * `--name` and the positional argument are the same answer written two ways,
   * and `deploy` reads them in this order — keep them in step. Asked for on a
   * terminal, defaulting to the directory's name the way `deploy` does, since
   * `pb cloud pb create` in a fresh project directory is the case this exists
   * for. Nothing is read from the directory but its name.
   */
  async function newInstanceName(ctx: CmdCtx): Promise<string> {
    const explicit = (ctx.raw.name as string | undefined) ?? ctx.args[0];
    if (explicit) return explicit;
    const opts = { noInput: ctx.flags.noInput || ctx.flags.json, io: deps.io };
    if (!canPrompt(opts)) {
      throw new CliError(
        "Pass a name: `pb cloud pb create <name>`.",
        2,
      );
    }
    const suggested = suggestName(deps.cwd());
    const answer = await prompt(
      `Name for the new PocketBase [${suggested}]:`,
      opts,
    );
    return answer || suggested;
  }

  /**
   * Which environment a `create` records its new instance under, and the
   * guards that have to pass before anything is provisioned.
   *
   * `deploy` gets all of this from `resolveTarget`, whose job is to *find* an
   * existing resource — the wrong shape here, where the resource does not exist
   * yet and the file is only a destination. The two guards are the same ones
   * deploy enforces, for the same reasons: `kind` is shared by every
   * environment in a pb.json, so a directory bound to frontends cannot also
   * bind a PocketBase; and repointing an environment that already names an
   * instance would silently orphan the binding to a live one.
   */
  async function environmentToRecord(
    ctx: CmdCtx,
    cwd: string,
  ): Promise<string> {
    const link = await readLinkFile(cwd);
    const opts = { noInput: ctx.flags.noInput || ctx.flags.json, io: deps.io };
    const choice = await chooseEnvironment(
      resolveEnvironmentName(link, { flag: ctx.raw.env as string | undefined }),
      link,
      opts,
    );
    if (link?.kind && link.kind !== "pocketbases") {
      throw new CliError(
        `pb.json is bound to ${link.kind} — create a PocketBase from a ` +
          `different directory.`,
        2,
      );
    }
    const bound = entryFor(link, "pocketbases", choice);
    if (bound) {
      throw new CliError(
        `pb.json already binds environment "${choice.name}" to PocketBase ` +
          `"${
            bound.name ?? bound.id
          }" (${bound.id}). Record the new instance ` +
          `under another environment with --env <name>, run this from a ` +
          `different directory, or remove the bound instance with ` +
          `\`pb cloud pb rm --name ${bound.name ?? bound.id}\`.`,
        2,
      );
    }
    return choice.name;
  }

  /**
   * Creates an empty instance and records it in this directory's pb.json.
   *
   * `deploy` is a directory command: it infers a build block, packages
   * pb_public/pb_hooks/pb_migrations, and asks which dotenv file the
   * environment uses, all before it creates anything. That is right for "ship
   * this directory" and wrong for "give me an instance" — a script, a CI step,
   * or a user with nothing to deploy yet. So `create` skips every one of those
   * steps and sends no archive at all.
   *
   * What it does keep is the binding: the instance is written into pb.json
   * under its environment exactly as a deploy would write it, so the next
   * `pb cloud pb deploy` here needs no --name. The rest of the create is shared
   * with `deploy` — owner, superuser credentials, compute, version, the
   * provisioning and reachability waits — so the two cannot drift into
   * producing differently-shaped instances.
   */
  const create: Handler = async (ctx: CmdCtx) => {
    const progress = deployProgress(ctx.flags.json);
    const { client, project: p, auth } = await progress.step(
      "Connecting to PocketBase Cloud",
      () => project(ctx, progress.log),
    );
    const cwd = deps.cwd();
    const log = (m: string) => progress.log(m);
    const noInput = ctx.flags.noInput || ctx.flags.json;
    const name = await newInstanceName(ctx);
    // Before the create, not after: a directory that cannot record the result
    // must fail while there is still nothing to clean up.
    const environment = await environmentToRecord(ctx, cwd);

    // The one thing that distinguishes create from deploy, so its refusal has
    // to name deploy. Creating a second instance under a name already in the
    // project would also make every later --name lookup ambiguous.
    const existing = findExisting(
      await client.listResources("pocketbases", p.id),
      { name },
    );
    if (existing === "ambiguous") {
      throw new CliError(
        `More than one PocketBase in this project is already named "${name}". ` +
          `Pick another name.`,
        2,
      );
    }
    if (existing) {
      throw new CliError(
        `A PocketBase named "${name}" already exists in this project ` +
          `(${existing.id}). Redeploy it with \`pb cloud pb deploy --name ` +
          `${name}\`, or create this one under another name.`,
        2,
      );
    }

    // Both required: the platform refuses the deploy when either is blank and
    // never fills them in itself.
    const credentials = await resolveAdminCredentials(client, {
      username: ctx.raw["admin-email"] as string | undefined,
      password: ctx.raw["admin-password"] as string | undefined,
    });
    const data: Record<string, unknown> = {
      project: p.id,
      name,
      user: await resolveOwnerId(client, auth),
      status: "creating",
      // Never blank: an empty version leaves the instance stranded in
      // `creating` with no error status ever written.
      version: await resolveDeployVersion(
        ctx.raw["pb-version"] as string | undefined,
        cwd,
        deps,
      ),
      ...credentials,
    };
    if (ctx.raw.location) data.location = ctx.raw.location;
    // A Pro account's dedicated compute is `ownership: "user"`, which the
    // platform's auto-selection (platform pool only) never picks.
    const compute = computeFlag(ctx.raw) ??
      await chooseCompute(client, p.id, { noInput, log, io: deps.io });
    if (compute) data.server = compute;
    // `--location` only means anything when the platform auto-selects, so it
    // is validated only once no compute has been settled on — a Pro or org
    // deploy lands on the named compute and ignores the flag, and checking it
    // against the shared pool there would reject a region that was never
    // going to be consulted.
    if (!compute && ctx.raw.location) {
      await validateLocationChoice(client, p.id, String(ctx.raw.location));
    }

    const resource = await progress.step(
      "Sending the create request",
      () => client.createResource("pocketbases", data),
    );
    // Recorded as soon as the record exists, not once it is running: an
    // instance that fails to provision is still one this directory owns, and a
    // binding is how `pb cloud pb deploy`, `info`, `logs` and `rm` reach it.
    // No envFile is written — nothing was pushed, so the first deploy here
    // still gets to ask which dotenv file this environment uses.
    await upsertEnvironment(cwd, {
      projectId: p.id,
      kind: "pocketbases",
      environment,
      entry: { id: resource.id, name: resource.name },
    });
    const final = await awaitDeployment(client, "pocketbases", resource, {
      progress,
      created: true,
      environment,
      label: "PocketBase",
      checkCommand: "pb",
    });
    if (final.status === "running") {
      reportUrl(final, { log, paths: [{ path: "/_/", label: "admin" }] });
    }
    const reachable = final.status === "running"
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
        environment,
        ...(reachable === undefined ? {} : { reachable }),
        ...credentials,
      }));
    } else {
      // The superuser account exists only on this instance, and a generated
      // password is shown exactly once — `pb cloud pb info` recovers it later.
      console.log(
        `Admin login: ${credentials.adminUsername} / ${credentials.adminPassword}`,
      );
      // Only once it is actually up: pointing at the next step of a deploy
      // that has not finished reads as if it had.
      if (final.status === "running") {
        console.log(
          `Recorded in pb.json as environment "${environment}" — ` +
            `\`pb cloud pb deploy\` here needs no --name.`,
        );
      }
    }
    return final.status === "running" ? 0 : 6;
  };

  const deploy: Handler = async (ctx: CmdCtx) => {
    const progress = deployProgress(ctx.flags.json);
    const { client, project: p, auth } = await progress.step(
      "Connecting to PocketBase Cloud",
      () => project(ctx, progress.log),
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

    // Refuse nested hook files before they travel in the archive. The platform
    // rejects them at the agent level, but that is after the upload.
    if (!ctx.raw.zip) {
      const own = await readOwnPbJson(cwd);
      const hooksDir = join(cwd, own.build?.pbHooks ?? "pb_hooks");
      try {
        const nested = await findNestedHooks(hooksDir);
        if (nested.length > 0) {
          throw new CliError(
            nested.map((f) =>
              `pb_hooks/${f} is inside a subdirectory and cannot be installed. ` +
              `Move it to pb_hooks/ directly.`
            ).join("\n"),
            2,
          );
        }
      } catch (e) {
        if (e instanceof CliError) throw e;
        // Directory doesn't exist — nothing to validate.
      }
    }

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
    // The upload route installs pb_hooks, pb_migrations and pb_public, so an
    // archive holding none of them must not be sent: the platform would reject
    // it and mark the instance errored. `bundle.empty` is the second half of
    // that: a directory can name pb_public and still package nothing, and an
    // entry-less archive fails the platform's unzip rather than installing
    // zero files.
    const hasUploadableDirs = Boolean(
      zipPath ?? build.pbPublic ?? build.pbMigrations ?? build.pbHooks,
    ) && !bundle.empty;
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
              // Skipped when the directory packaged nothing: the platform
              // accepts a create with no archive at all, but not one holding
              // no files.
              if (!bundle.empty) attachZip(extra, bundle);
              return extra;
            },
            // Only a --zip needs checking: a packaged archive stages every
            // directory under its canonical name, so it is right by
            // construction.
            beforeUpdate: zipPath
              ? () => assertUploadableArchive(bundle.bytes, bundle.fileName)
              : undefined,
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
      // No separate hooks push any more: pb_hooks travels in the archive and
      // the platform installs it through the same hooks route this used to
      // call, so pushing again would write everything twice and restart the
      // instance twice. `pb cloud hooks push` still exists for hooks alone.
      log(
        hasUploadableDirs
          ? "Uploaded the archive: pb_hooks and pb_migrations are merged into " +
            "the instance and pb_public replaced. New migrations run on the " +
            "restart that follows."
          : nothingToDeployNote(cwd, false),
      );
    } else if (bundle.empty) {
      log(nothingToDeployNote(cwd, true));
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
        noInput: ctx.flags.noInput || ctx.flags.json,
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
    if (!res.ok) throw await httpError(res, "Hook list");
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
    if (!res.ok) throw await httpError(res, "Hook delete");
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Deleted ${filename}.`,
    );
    return 0;
  };

  function domainHandler(path: string): Handler {
    return async (ctx: CmdCtx) => {
      const domain = ctx.args[0];
      if (!domain) {
        throw new CliError(
          "Usage: pb cloud pb domain <add|verify|remove> <domain> --name <instance>",
          2,
        );
      }
      const { client, found } = await resolveOne({
        ...ctx,
        args: ctx.args.slice(1),
      });
      const res = await client.ext(path, {
        pocketbase_id: found.id,
        custom_domain: domain,
      });
      if (!res.ok) {
        // The route's own sentence, not a JSON dump of its whole body.
        throw await httpError(res, `Domain ${path.split("/").pop()}`);
      }
      const body = await res.json().catch(() => ({}));
      console.log(
        ctx.flags.json
          ? JSON.stringify(body)
          : `OK: ${path.split("/").pop()} ${domain}.`,
      );
      return 0;
    };
  }

  return {
    "cloud pb create": create,
    "cloud pb deploy": deploy,
    "cloud pb ls": ls,
    "cloud pb info": info,
    "cloud pb rm": rm,
    "cloud pb hooks push": hooksPush,
    "cloud pb hooks ls": hooksLs,
    "cloud pb hooks rm": hooksRm,
    "cloud pb domain add": domainHandler(
      "/api/pocketbases/custom-domain/add",
    ),
    "cloud pb domain verify": domainHandler(
      "/api/pocketbases/custom-domain/verify",
    ),
    "cloud pb domain remove": domainHandler(
      "/api/pocketbases/custom-domain/remove",
    ),
  };
}
