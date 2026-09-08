import { join } from "@std/path";
import {
  bool,
  type CmdCtx,
  type Command,
  defineCommand,
  path,
  renamed,
  retired,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource } from "../clients/types.ts";
import { CliError, httpError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { printResult } from "../ui/output.ts";
import { canPrompt, prompt } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";
import type { BuildConfig } from "../config.ts";
import {
  readLinkFile,
  readOwnLinkFile,
  removeEnvironment,
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
  awaitDeployment,
  awaitReachable,
  buildBundle,
  chooseCompute,
  computeChooser,
  deployProgress,
  deployResource,
  envFileEntry,
  findExisting,
  pushEnvFile,
  reportUrl,
  resolveAdminCredentials,
  resolveDeployIntent,
  resolveEnvFile,
  resolveEnvironmentTarget,
  resolveOwnerId,
  suggestName,
  uploadLabel,
  validateLocationChoice,
} from "./deploy-helper.ts";
import { deployArchive, waitForDeployment } from "../clients/deployments.ts";
import { reportDeploymentLogs } from "./logs.ts";
import { makeResourceResolver } from "./resource.ts";
import { KINDS } from "../kinds.ts";

const HOOK_EXTENSIONS = [".js", ".json"];

const MAX_HOOKS_PER_PUSH = 30;
const RUNTIME_DEFAULTS: Record<string, boolean | number | string> = {
  automigrate: true,
  dev: false,
  dir: "pb_data",
  encryptionEnv: "",
  hooksDir: "pb_hooks",
  hooksPool: 15,
  hooksWatch: false,
  indexFallback: true,
  migrationsDir: "pb_migrations",
  publicDir: "pb_public",
  queryTimeout: 30,
};
const EDITABLE_RUNTIME_KEYS = ["dev", "hooksPool", "queryTimeout"] as const;

function parseBooleanFlag(
  name: string,
  value: string | undefined,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CliError(`--${name} must be true or false.`, { code: "USAGE" });
}

function runtimeFlags(
  input: Record<string, string | undefined>,
): Record<string, boolean | number | string> {
  const result: Record<string, boolean | number | string> = {};
  const dev = parseBooleanFlag("dev", input.dev);
  if (dev !== undefined) result.dev = dev;
  for (const key of ["hooksPool", "queryTimeout"]) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value)) {
      throw new CliError(`--${key} must be an integer.`, { code: "USAGE" });
    }
    result[key] = value;
  }
  return result;
}

function editableRuntimeFlags(
  input: Record<string, boolean | number | string>,
): Record<string, boolean | number | string> {
  const result: Record<string, boolean | number | string> = {};
  for (const key of EDITABLE_RUNTIME_KEYS) {
    result[key] = input[key] ?? RUNTIME_DEFAULTS[key];
  }
  return result;
}

async function uploadBackup(
  client: ICloudClient,
  filePath: string,
): Promise<string> {
  const info = await Deno.stat(filePath).catch(() => null);
  if (!info?.isFile) {
    throw new CliError(`Backup not found: ${filePath}`, { code: "USAGE" });
  }
  const response = await client.ext("/api/pocketbases/backup-upload-url", {});
  if (!response.ok) throw await httpError(response, "Backup upload URL");
  const body = await response.json() as {
    data: { key: string; uploadUrl: string; maxMB: number };
  };
  if (info.size > body.data.maxMB * 1024 * 1024) {
    throw new CliError(`Backup exceeds the ${body.data.maxMB} MB limit.`, {
      code: "INVALID_VALUE",
    });
  }
  const upload = await fetch(body.data.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/zip" },
    body: await Deno.readFile(filePath),
  });
  await upload.body?.cancel();
  if (!upload.ok) {
    throw new CliError(`Backup upload failed (${upload.status}).`, {
      code: "NETWORK_ERROR",
    });
  }
  return body.data.key;
}

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

const MAX_HOOK_CONTENT_CHARS = 300_000;

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function assertUploadableArchive(bytes: Uint8Array, fileName: string): void {
  const names = zipEntryNames(bytes);
  if (names === null) {
    throw new CliError(`${fileName} is not a zip archive.`, { code: "USAGE" });
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
    { code: "USAGE" },
  );
}

function nothingToDeployNote(cwd: string, created: boolean): string {
  return `Note: nothing to deploy from ${cwd} — no pb_public, pb_hooks or ` +
    `pb_migrations directory was found, so ${
      created
        ? "the instance was created bare"
        : "nothing was installed and the instance was restarted as-is"
    }. Add one of those directories, or point build.pbPublic / build.pbHooks ` +
    `/ build.pbMigrations in pbc.json at where yours live, then deploy again.`;
}

export async function pushHooks(
  client: ICloudClient,
  pocketbaseId: string,
  dir: string,
  log: (msg: string) => void = () => {},
): Promise<{ sent: number; stored: number }> {
  const names: string[] = [];
  const subdirs: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        subdirs.push(entry.name);
        continue;
      }
      if (!entry.isFile) continue;
      if (!HOOK_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      names.push(entry.name);
    }
  } catch {
    throw new CliError(`Hooks directory not found: ${dir}`, { code: "USAGE" });
  }
  for (const name of subdirs) {
    log(
      `Skipped ${name}/ — the platform stores hooks as flat files, so ` +
        `subdirectories are not uploaded.`,
    );
  }
  if (names.length === 0) return { sent: 0, stored: 0 };
  if (names.length > MAX_HOOKS_PER_PUSH) {
    throw new CliError(
      `${names.length} hook files in ${dir} — pbc pushes at most ` +
        `${MAX_HOOKS_PER_PUSH} at a time. Check that this is your pb_hooks ` +
        `directory.`,
      { code: "USAGE" },
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
      active: true,
    });
  }
  if (oversized.length > 0) {
    throw new CliError(
      `${oversized.join(", ")} — a hook file may be at most ` +
        `${formatCount(MAX_HOOK_CONTENT_CHARS)} characters. Split it up and ` +
        `require() the parts.`,
      { code: "USAGE" },
    );
  }
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

async function resolveDeployVersion(
  flagVersion: string | undefined,
  cwd: string,
  deps: CloudCmdDeps,
): Promise<string> {
  const pinned = flagVersion ?? (await readOwnLinkFile(cwd)).pocketbaseVersion;
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

export function makePbCommands(deps: CloudCmdDeps): Record<string, Command> {
  async function project(ctx: CmdCtx, log?: (m: string) => void) {
    const { client, config, auth } = await deps.requireAuth();
    const p = await resolveProject({
      client,
      config,
      cwd: deps.cwd(),
      flagProject: ctx.flags.project,
      noInput: ctx.flags.noInput || ctx.flags.json,
      log: log ?? ((m) => console.error(m)),
    });
    return { client, project: p, auth };
  }

  async function newInstanceName(
    ctx: CmdCtx,
    name: string | undefined,
  ): Promise<string> {
    const explicit = name ?? ctx.args[0];
    if (explicit) return explicit;
    const opts = { noInput: ctx.flags.noInput || ctx.flags.json, io: deps.io };
    if (!canPrompt(opts)) {
      throw new CliError(
        "Pass a name: `pbc pocketbase create <name>`.",
        { code: "USAGE" },
      );
    }
    const suggested = suggestName(deps.cwd());
    const answer = await prompt(
      `Name for the new PocketBase [${suggested}]:`,
      opts,
    );
    return answer || suggested;
  }

  async function environmentToRecord(
    ctx: CmdCtx,
    cwd: string,
    env: string | undefined,
  ): Promise<string> {
    const link = await readLinkFile(cwd);
    const opts = { noInput: ctx.flags.noInput || ctx.flags.json, io: deps.io };
    const choice = await chooseEnvironment(
      resolveEnvironmentName(link, { flag: env }),
      link,
      opts,
    );
    if (link?.kind && link.kind !== "pocketbases") {
      throw new CliError(
        `pbc.json is bound to ${link.kind} — create a PocketBase from a ` +
          `different directory.`,
        { code: "USAGE" },
      );
    }
    const bound = entryFor(link, "pocketbases", choice);
    if (bound) {
      throw new CliError(
        `pbc.json already binds environment "${choice.name}" to PocketBase ` +
          `"${
            bound.name ?? bound.id
          }" (${bound.id}). Record the new instance ` +
          `under another environment with --env <name>, run this from a ` +
          `different directory, or remove the bound instance with ` +
          `\`pbc pocketbase rm --name ${bound.name ?? bound.id}\`.`,
        { code: "USAGE" },
      );
    }
    return choice.name;
  }

  const { resolveOne } = makeResourceResolver(deps, KINDS.pocketbases);

  return {
    "pocketbase create": defineCommand({
      path: ["pocketbase", "create"],
      usage:
        "pbc pocketbase create [<name>] [--env <name>] [--location <loc>] [--compute <id>] [--admin-email <e>] [--admin-password <p>] [--pb-version <v>] [--backup <zip>]",
      summary: "Create a PocketBase instance.",
      details: `Provisions a running instance with nothing deployed to it — no
pb_public, pb_hooks or pb_migrations — and waits until it answers.

Nothing is built, packaged, or uploaded, and no env file is asked about. Use it
to get a database from a script, from a directory that holds no project, or
before there is anything to deploy.

The new instance is recorded in this directory's pbc.json, under the environment
this command targets, exactly as a deploy would record it — so the next
\`pbc pocketbase deploy\` here needs no --name:

  pbc pocketbase create my-app-db
  pbc pocketbase deploy              # ships this directory to it

--env names the environment (default: production, or the file's own default).
A directory bound to frontends or backends is refused, and so is an environment
that already names an instance: repointing it would leave the old one with
nothing pointing at it. Pass --env <other>, or run this somewhere else.

\`pbc pocketbase deploy\` also creates an instance when there is none yet, and
creates it bare when the directory holds none of the three directories — so
this command is the explicit way to do the same thing when there is nothing to
package.

The name comes from the argument or --name, and is asked for on a terminal
(defaulting to the directory's name) when neither is given. A name already used
by an instance in this project is refused rather than duplicated: redeploy that
one with \`pbc pocketbase deploy --name <name>\` instead.

The instance gets a superuser account — your account email, and a generated
password printed once when it finishes (and readable afterwards with
\`pbc pocketbase info\`). Override either with --admin-email/--admin-password.

The compute is chosen exactly as a deploy chooses it: on Pro, and in a project
shared with an organization, the owner's compute is used, asked about when
there is more than one, and settled outright by --compute. On the free and
starter plans the platform picks from its shared pool.

Advanced configuration: --dev, --hooks-pool, and --query-timeout adjust the
runtime. --backup restores a PocketBase backup ZIP during creation. Existing
superusers are preserved, so --backup cannot be combined with the admin flags.`,
      args: [{
        name: "name",
        required: false,
        description: "Positional name, alternative to --name",
      }],
      flags: {
        name: str({
          description:
            "What to call the instance. Asked for on a terminal when omitted.",
        }),
        env: str({
          description:
            "Which pbc.json environment to record the instance under. Defaults " +
            "to the file's default, or production.",
        }),
        location: str({
          description:
            "Region for the instance, on Starter. Optional — without it the " +
            "platform picks the region with the most free capacity.",
        }),
        compute: str({
          description:
            "Compute to create the instance on. Asked for when the project owner " +
            "has more than one; required under --no-input/--json.",
        }),
        server: renamed("compute", {
          description: "Old name for --compute; scripts may keep using it.",
        }),
        adminEmail: str({
          description:
            "Superuser login for the new instance. Defaults to your account email.",
        }),
        adminPassword: str({
          description:
            "Superuser password, 12-20 characters. Generated and printed once when omitted.",
        }),
        pbVersion: str({
          description:
            "PocketBase release to install. Defaults to pocketbaseVersion in pbc.json.",
        }),
        dev: str({ description: "Enable PocketBase dev mode: true or false." }),
        hooksPool: str({ description: "Hooks runtime pool size, 1-100." }),
        queryTimeout: str({ description: "Query timeout in seconds, 1-3600." }),
        backup: path({
          description: "PocketBase backup ZIP to restore during creation.",
          conflicts: ["adminEmail", "adminPassword"],
        }),
      },
      run: async (input, ctx) => {
        const progress = deployProgress(ctx.flags.json);
        const { client, project: p, auth } = await progress.step(
          "Connecting to PocketBase Cloud",
          () => project(ctx, progress.log),
        );
        const cwd = deps.cwd();
        const log = (m: string) => progress.log(m);
        const noInput = ctx.flags.noInput || ctx.flags.json;
        const name = await newInstanceName(ctx, input.name);
        const environment = await environmentToRecord(ctx, cwd, input.env);

        const existing = findExisting(
          await client.listResources("pocketbases", { project: p.id }),
          { name },
        );
        if (existing === "ambiguous") {
          throw new CliError(
            `More than one PocketBase in this project is already named "${name}". ` +
              `Pick another name.`,
            { code: "CONFLICT" },
          );
        }
        if (existing) {
          throw new CliError(
            `A PocketBase named "${name}" already exists in this project ` +
              `(${existing.id}). Redeploy it with \`pbc pocketbase deploy --name ` +
              `${name}\`, or create this one under another name.`,
            { code: "CONFLICT", hint: `pbc pocketbase deploy --name ${name}` },
          );
        }

        const credentials = input.backup
          ? undefined
          : await resolveAdminCredentials(client, {
            username: input.adminEmail,
            password: input.adminPassword,
          });
        const backupKey = input.backup
          ? await progress.step(
            "Uploading PocketBase backup",
            () => uploadBackup(client, input.backup!),
          )
          : undefined;
        const data: Record<string, unknown> = {
          project: p.id,
          name,
          user: await resolveOwnerId(client, auth),
          status: "creating",
          version: await resolveDeployVersion(input.pbVersion, cwd, deps),
          ...(credentials ?? {}),
          ...(backupKey ? { backupKey } : {}),
          runtimeFlags: {
            ...RUNTIME_DEFAULTS,
            ...runtimeFlags(input as Record<string, string | undefined>),
          },
        };
        if (input.location) data.location = input.location;
        const compute = input.compute ??
          await chooseCompute(client, p.id, { noInput, log, io: deps.io });
        if (compute) data.server = compute;
        if (!compute && input.location) {
          await validateLocationChoice(client, p.id, input.location);
        }

        const resource = await progress.step(
          "Sending the create request",
          async () => {
            const response = await client.ext("/api/pocketbases/create", data);
            if (!response.ok) {
              throw await httpError(response, "PocketBase create");
            }
            return (await response.json() as { data: Resource }).data;
          },
        );
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
          checkCommand: "pocketbase",
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
          emit(true, {
            ...final,
            environment,
            ...(reachable === undefined ? {} : { reachable }),
            ...(credentials ?? {}),
          }, "");
        } else {
          if (credentials) {
            console.log(
              `Admin login: ${credentials.adminUsername} / ${credentials.adminPassword}`,
            );
          } else if (input.backup) {
            console.log(
              "Admin login: preserved from backup; credentials are not available to PocketBase Cloud.",
            );
          }
          if (final.status === "running") {
            console.log(
              `Recorded in pbc.json as environment "${environment}" — ` +
                `\`pbc pocketbase deploy\` here needs no --name.`,
            );
          }
        }
        return final.status === "running" ? 0 : 6;
      },
    }),

    "pocketbase deploy": defineCommand({
      path: ["pocketbase", "deploy"],
      needs: ["target:pocketbases", { explicit: true }],
      usage:
        "pbc pocketbase deploy [--name <name>] [--new <name>] [--location <loc>] [--compute <id>] [--admin-email <e>] [--admin-password <p>] [--pb-version <v>] [--skip-env] [--env <name>]",
      summary: "Create or redeploy a PocketBase instance.",
      details:
        `Packages pb_public, pb_hooks, and pb_migrations and ships them with the
instance. Their locations come from the "build" block in pbc.json, which
is inferred from the directory and written there on the first deploy.

A redeploy ships them too: the .js and .json files in pb_hooks go through the
hooks route (which keeps the portal's editor in sync), and the archive's
pb_migrations and pb_public are installed on the running instance — migrations
merged with the ones already there, pb_public replaced wholesale. New
migrations are applied by the restart that follows.

Hooks are stored as flat files, so a subdirectory of pb_hooks is not uploaded
and the deploy says which ones it skipped.

None of the three directories is required. A directory that holds none of them
still deploys: no archive is sent at all, a new instance is created empty, and
the deploy says so rather than reporting a silent success. \`pbc pocketbase create\`
does the same thing without involving a directory.

A new instance gets a superuser account: your account email, and a generated
password printed once when the deploy finishes (and readable afterwards with
\`pbc pocketbase info\`). Override either with --admin-email/--admin-password.

Each wait — installing, building, packaging, uploading, provisioning, waiting
for the domain — is reported as its own step, with a spinner and the elapsed
time on a terminal, plain lines when the output is piped, and nothing at all
under --json.

Env vars are pushed only from the file you name — nothing is uploaded by
default. Each environment has its own: the first deploy of an environment asks
which dotenv file it uses (or none) and records the answer as envFile under
that environment in pbc.json, so it is asked once. --env-file names one outright
and is recorded the same way when the environment has none yet. Pushing merges,
keeping cloud-only keys; --delete-missing removes them so the file is the whole
truth, and --skip-env pushes nothing for this run. A file whose variables are
unchanged since the last push is not uploaded again — pass --force-env to push
it anyway, e.g. after editing the variables in the portal.

With no --name and nothing bound in pbc.json, deploy asks which instance to
redeploy — or what to call a new one — the way it already asks which project
to use. Pass --no-input (or --json) to get the usage error instead.

Creating an instance also picks the compute it runs on, whenever there is a
choice to make: on Pro, and in a project shared with an organization, where the
compute is the owner's. One compute is used without asking, several are offered
as a menu, and --compute settles it outright. On the free and starter plans the
platform picks from the shared pool and the flag is unnecessary. A redeploy
never moves an existing instance.`,
      args: [],
      flags: {
        name: str({
          description:
            "Which existing PocketBase to redeploy. Asked for when omitted and pbc.json has no binding.",
          conflicts: ["new"],
        }),
        new: str({
          description:
            "Create a new PocketBase with this name. Fails if the name is taken.",
          conflicts: ["name"],
        }),
        location: str({
          description:
            "Region for the deploy, on Starter. Optional — without it the " +
            "platform picks the region with the most free capacity.",
        }),
        compute: str({
          description:
            "Compute to create the instance on. Asked for when the project owner " +
            "has more than one; required under --no-input/--json.",
        }),
        server: renamed("compute", {
          description: "Old name for --compute; scripts may keep using it.",
        }),
        adminEmail: str({
          description:
            "Superuser login for the new instance. Defaults to your account email.",
        }),
        adminPassword: str({
          description:
            "Superuser password, 12-20 characters. Generated and printed once when omitted.",
        }),
        pbVersion: str({
          description:
            "PocketBase release to install. Defaults to pocketbaseVersion in pbc.json.",
        }),
        skipBuild: bool({
          description: "Package without running the build command.",
        }),
        skipEnv: bool({
          description:
            "Push no env vars for this run, whatever pbc.json configures.",
        }),
        envFile: path({
          description:
            "Dotenv file to push. Recorded in pbc.json for this environment " +
            "when it has none yet.",
        }),
        deleteMissing: bool({
          description: "Remove cloud env vars the pushed file does not list.",
        }),
        forceEnv: bool({
          description:
            "Push env vars even when they are unchanged since the last push.",
        }),
        zip: str({
          description:
            "Upload this archive instead of packaging the directory.",
        }),
        env: str({
          description:
            "Which pbc.json environment to target. Defaults to the file's " +
            "default, or production.",
        }),
        subdomain: retired({
          description: "",
          since: "0.6.0",
          note: "Frontends use uid addresses.",
        }),
      },
      run: async (input, ctx) => {
        const progress = deployProgress(ctx.flags.json);
        const { client, project: p, auth } = await progress.step(
          "Connecting to PocketBase Cloud",
          () => project(ctx, progress.log),
        );
        const cwd = deps.cwd();
        const name = input.name ?? ctx.args[0];
        const envTarget = await resolveEnvironmentTarget(
          { name },
          "pocketbases",
          cwd,
          {
            envFlag: input.env,
            allowNewEnvironment: true,
            strictKind: true,
            askEnvironment: { noInput: ctx.flags.noInput || ctx.flags.json },
          },
        );
        const target = await resolveDeployIntent(envTarget, {
          client,
          spec: KINDS.pocketbases,
          projectId: p.id,
          cwd,
          newName: input.new,
          noInput: ctx.flags.noInput || ctx.flags.json,
          io: deps.io,
          onStale: () => removeEnvironment(cwd, envTarget.environment),
        });
        const log = (m: string) => progress.log(m);
        const zipPath = input.zip;
        const data: Record<string, unknown> = { project: p.id };
        if (input.location) data.location = input.location;
        const compute = input.compute;
        if (compute) data.server = compute;
        const askCompute = computeChooser(client, p.id, {
          noInput: ctx.flags.noInput || ctx.flags.json,
          log,
        });

        if (!input.zip) {
          const own = await readOwnLinkFile(cwd);
          const hooksDir = join(cwd, own.build?.pbHooks ?? "pb_hooks");
          try {
            const nested = await findNestedHooks(hooksDir);
            if (nested.length > 0) {
              throw new CliError(
                nested.map((f) =>
                  `pb_hooks/${f} is inside a subdirectory and cannot be installed. ` +
                  `Move it to pb_hooks/ directly.`
                ).join("\n"),
                { code: "USAGE" },
              );
            }
          } catch (e) {
            if (e instanceof CliError) throw e;
          }
        }

        const bundle = await buildBundle({
          cwd,
          kind: "pocketbases",
          zipPath,
          skipBuild: input.skipBuild === true,
          envFile: input.envFile,
          environment: target.environment,
          log,
          progress,
        });
        const build: BuildConfig = bundle.build;
        const env = await resolveEnvFile({
          cwd,
          build,
          environment: target.environment,
          flag: input.envFile,
          skip: input.skipEnv === true,
          noInput: ctx.flags.noInput || ctx.flags.json,
        });
        const hasUploadableDirs = Boolean(
          zipPath ?? build.pbPublic ?? build.pbMigrations ?? build.pbHooks,
        ) && !bundle.empty;

        let credentials:
          | { adminUsername: string; adminPassword: string }
          | null = null;
        const { resource, created } = await progress.step(
          uploadLabel(bundle),
          async (step) => {
            const out = await deployResource(
              client,
              "pocketbases",
              target,
              {
                data,
                createData: async () => {
                  credentials = await resolveAdminCredentials(client, {
                    username: input.adminEmail,
                    password: input.adminPassword,
                  });
                  const extra: Record<string, unknown> = {
                    user: await resolveOwnerId(client, auth),
                    status: "creating",
                    ...credentials,
                  };
                  if (!data.server) {
                    const picked = await askCompute();
                    if (picked) extra.server = picked;
                  }
                  extra.version = await resolveDeployVersion(
                    input.pbVersion,
                    cwd,
                    deps,
                  );
                  return extra;
                },
                beforeUpdate: zipPath
                  ? () => assertUploadableArchive(bundle.bytes, bundle.fileName)
                  : undefined,
              },
            );
            const { deploymentId } = await deployArchive({
              kind: "pocketbases",
              resourceId: out.resource.id,
              bytes: bundle.bytes,
              onProgress: (f) =>
                step.update(`Uploading — ${Math.round(f * 100)}%`),
            }, {
              baseUrl: auth.extUrl,
              token: auth.userToken,
              fetchFn: deps.fetch,
            });
            const dep = await waitForDeployment(deploymentId, {
              baseUrl: auth.backendUrl,
              token: auth.userToken,
              fetchFn: deps.fetch,
            });
            await reportDeploymentLogs(client, {
              type: "pocketbase",
              targetId: out.resource.id,
              log: ctx.flags.json ? (m) => console.error(m) : log,
            });
            if (dep.status === "failed") {
              throw new CliError(dep.statusMessage, { code: "PLATFORM_ERROR" });
            }
            return out;
          },
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
            deleteMissing: input.deleteMissing === true,
            force: input.forceEnv === true,
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
          checkCommand: "pocketbase",
        });
        const admin = credentials as
          | { adminUsername: string; adminPassword: string }
          | null;
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
          emit(true, {
            ...final,
            environment: target.environment,
            ...(reachable === undefined ? {} : { reachable }),
            ...(admin ?? {}),
          }, "");
        }
        if (!ctx.flags.json && admin) {
          console.log(
            `Admin login: ${admin.adminUsername} / ${admin.adminPassword}`,
          );
        }
        return final.status === "running" ? 0 : 6;
      },
    }),

    "pocketbase config get": defineCommand({
      path: ["pocketbase", "config", "get"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase config get [--name <instance>]",
      summary: "Show PocketBase runtime configuration.",
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const resource = await client.getResource("pocketbases", found.id);
        const config = editableRuntimeFlags({
          ...RUNTIME_DEFAULTS,
          ...(resource.runtimeFlags ?? {}),
        });
        emit(ctx.flags.json, config, JSON.stringify(config, null, 2));
        return 0;
      },
    }),

    "pocketbase config set": defineCommand({
      path: ["pocketbase", "config", "set"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase config set [--name <instance>] [runtime flags]",
      summary: "Update PocketBase runtime configuration.",
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
        dev: str({ description: "true or false." }),
        hooksPool: str({ description: "Hooks pool size, 1-100." }),
        queryTimeout: str({ description: "Query timeout, 1-3600 seconds." }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const changed = runtimeFlags(
          input as Record<string, string | undefined>,
        );
        if (Object.keys(changed).length === 0) {
          throw new CliError("Pass at least one runtime flag.", {
            code: "USAGE",
          });
        }
        const current = await client.getResource("pocketbases", found.id);
        const runtime = {
          ...RUNTIME_DEFAULTS,
          ...(current.runtimeFlags ?? {}),
          ...changed,
        };
        const response = await client.ext("/api/pocketbases/runtime-config", {
          pocketbaseId: found.id,
          runtimeFlags: runtime,
        });
        if (!response.ok) throw await httpError(response, "PocketBase config");
        emit(
          ctx.flags.json,
          editableRuntimeFlags(runtime),
          "Runtime configuration updated.",
        );
        return 0;
      },
    }),

    "pocketbase superuser sync": defineCommand({
      path: ["pocketbase", "superuser", "sync"],
      needs: ["target:pocketbases", { explicit: true }],
      usage:
        "pbc pocketbase superuser sync --email <email> --password <password> [--name <instance>]",
      summary: "Add or update the managed PocketBase superuser.",
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
        email: str({ description: "Managed superuser email.", required: true }),
        password: str({
          description: "Managed superuser password.",
          required: true,
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const response = await client.ext("/api/pocketbases/sync-superuser", {
          pocketbaseId: found.id,
          email: input.email,
          password: input.password,
        });
        if (!response.ok) {
          throw await httpError(response, "PocketBase superuser sync");
        }
        emit(
          ctx.flags.json,
          { id: found.id, email: input.email },
          "Superuser synchronized.",
        );
        return 0;
      },
    }),

    "pocketbase hooks push": defineCommand({
      path: ["pocketbase", "hooks", "push"],
      usage: "pbc pocketbase hooks push <dir> [--name <instance>]",
      summary: "Upload every .js and .json file in <dir> as a hook.",
      details:
        `Hooks belong to one PocketBase instance. Name it with --name/--id, or let
the directory's pbc.json binding pick it.

PocketBase itself only runs *.pb.js, but the plain .js and .json files beside
them are uploaded too — a hook that requires a helper module or a data file
needs it on the instance. Subdirectories are not uploaded: the platform stores
hooks as flat files. At most 30 files per push — a bigger directory is nearly
always the wrong one.`,
      args: [{ name: "dir", required: true }],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory's binding.",
        }),
      },
      run: async (input, ctx) => {
        const dir = ctx.args[0];
        if (!dir) {
          throw new CliError(
            "Usage: pbc pocketbase hooks push <dir>",
            { code: "USAGE" },
          );
        }
        const { client, found } = await resolveOne(ctx, input, {
          args: ctx.args.slice(1),
        });
        const log = ctx.flags.json ? () => {} : (m: string) => console.log(m);
        const { sent, stored } = await pushHooks(client, found.id, dir, log);
        if (sent === 0) {
          throw new CliError(
            `No ${HOOK_EXTENSIONS.join(" or ")} files in ${dir}.`,
            { code: "USAGE" },
          );
        }
        emit(
          ctx.flags.json,
          { pushed: stored },
          `Pushed ${stored} hook file(s).`,
        );
        return 0;
      },
    }),

    "pocketbase hooks ls": defineCommand({
      path: ["pocketbase", "hooks", "ls"],
      usage: "pbc pocketbase hooks ls [--name <instance>]",
      summary: "List uploaded hook files.",
      details:
        "Lists hooks uploaded with `pbc pocketbase hooks push`. Hooks shipped\n" +
        "inside a deploy archive (pb_hooks/ packaged by `pbc pocketbase deploy`)\n" +
        "run on the instance but are not recorded here, so this can read empty\n" +
        "while hooks are live. Push them to manage them from the CLI.",
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory's binding.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const res = await client.pbApi("/api/hooks", undefined, {
          method: "GET",
          query: { pocketbase_id: found.id },
        });
        if (!res.ok) throw await httpError(res, "Hook list");
        const body = await res.json() as {
          hooks?: { filename: string; active?: boolean; updated?: string }[];
        };
        printResult(body.hooks ?? [], [
          { header: "FILENAME", get: (h) => h.filename },
          { header: "ACTIVE", get: (h) => h.active === false ? "" : "yes" },
          { header: "UPDATED", get: (h) => h.updated ?? "" },
        ], ctx.flags.json);
        return 0;
      },
    }),

    "pocketbase hooks rm": defineCommand({
      path: ["pocketbase", "hooks", "rm"],
      usage: "pbc pocketbase hooks rm <filename> [--name <instance>]",
      summary: "Delete a hook file.",
      args: [{ name: "filename", required: true }],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory's binding.",
        }),
      },
      run: async (input, ctx) => {
        const filename = ctx.args[0];
        if (!filename) {
          throw new CliError(
            "Usage: pbc pocketbase hooks rm <filename>",
            { code: "USAGE" },
          );
        }
        const { client, found } = await resolveOne(ctx, input, {
          args: ctx.args.slice(1),
        });
        const res = await client.pbApi("/api/hooks/delete", {
          pocketbase_id: found.id,
          hook_filename: filename,
        });
        if (!res.ok) throw await httpError(res, "Hook delete");
        emit(ctx.flags.json, { ok: true }, `Deleted ${filename}.`);
        return 0;
      },
    }),
  };
}
