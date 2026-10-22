import { join, resolve } from "@std/path";
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
import {
  deployToPreview,
  PREVIEW_SIZES,
  type PreviewSize,
  previewUrl,
} from "./pb-preview.ts";
import { printResult, renderTable } from "../ui/output.ts";
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
  archiveOf,
  awaitDeployment,
  awaitReachable,
  buildBundle,
  chooseCompute,
  computeChooser,
  deploymentFailure,
  deployProgress,
  deployResource,
  deployTargetLine,
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
import {
  commitFiles,
  type CommitFilesResult,
  type FileEntry,
  recordedRevisionOf,
} from "../clients/file-commit.ts";
import { type DeployCommit, readDeployCommit } from "../git-commit.ts";
import { formatSize } from "../build/package.ts";
import { HashIndex } from "../hash-index.ts";
import { linkedRepository, linkedWarning } from "../clients/repo-link.ts";
import {
  boundRevision,
  currentRevision,
  rememberRevision,
} from "./revisions.ts";
import { reportDeploymentLogs } from "./logs.ts";
import { makeResourceResolver } from "./resource.ts";
import { KINDS } from "../kinds.ts";
import { assertDeployableAs } from "../build/misdirected.ts";

const HOOK_EXTENSIONS = [
  ".pb.js",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".html",
  ".htm",
  ".css",
  ".txt",
  ".md",
  ".csv",
  ".xml",
  ".svg",
  ".yml",
  ".yaml",
];

const MAX_HOOKS_PER_PUSH = 500;
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

const MAX_HOOK_PATH_SEGMENTS = 6;

async function collectHookFiles(
  dir: string,
  relPrefix: string,
  names: string[],
  tooDeep: string[],
): Promise<void> {
  for await (const entry of Deno.readDir(join(dir, relPrefix))) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      await collectHookFiles(dir, rel, names, tooDeep);
      continue;
    }
    if (!entry.isFile) continue;
    if (!HOOK_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    if (rel.split("/").length > MAX_HOOK_PATH_SEGMENTS) {
      tooDeep.push(rel);
      continue;
    }
    names.push(rel);
  }
}

const MAX_HOOK_CONTENT_CHARS = 300_000;

export function committableEntries(entries: FileEntry[]): FileEntry[] {
  return entries.filter((entry) =>
    !entry.name.startsWith("pb_hooks/") ||
    HOOK_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
  );
}

const REPLACED_DIRS = ["pb_hooks", "pb_public"];

export function replacedDirs(entries: FileEntry[]): string[] {
  return REPLACED_DIRS.filter((dir) =>
    entries.some((entry) => entry.name.startsWith(`${dir}/`))
  );
}

export function describeUpload(
  result: { upload: number; uploadBytes: number; total: number },
): string {
  const unchanged = result.total - result.upload;
  return result.upload === 0
    ? `all ${result.total} file(s) already on the platform`
    : `${result.upload} new file(s), ${
      formatSize(result.uploadBytes)
    }; ${unchanged} already on the platform`;
}

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
  baseRevision?: number,
  onUndo?: (revision: number) => Promise<void>,
  git?: DeployCommit,
): Promise<{ sent: number; stored: number }> {
  const names: string[] = [];
  const tooDeep: string[] = [];
  try {
    await collectHookFiles(dir, "", names, tooDeep);
  } catch {
    throw new CliError(`Hooks directory not found: ${dir}`, { code: "USAGE" });
  }
  for (const name of tooDeep) {
    log(
      `Skipped ${name} — nested more than ${
        MAX_HOOK_PATH_SEGMENTS - 1
      } directories deep, which pb_hooks does not support.`,
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
    base_revision: baseRevision,
    ...(git && { git }),
  });
  if (!res.ok) {
    const recorded = await recordedRevisionOf(res);
    if (recorded !== undefined) await onUndo?.(recorded);
    throw await httpError(res, "Hook push");
  }
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
      usage: "pbc pocketbase create [<name>] [flags]",
      summary: "Create a PocketBase instance.",
      details: `Provisions a running instance with nothing deployed to it — no
pb_public, pb_hooks or pb_migrations — and waits until it answers. Use it to
get a database before there is anything to deploy.

The instance is recorded in this directory's pbc.json under the target
environment, exactly as a deploy would record it, so the next
\`pbc pocketbase deploy\` here needs no --name. A directory bound to another
kind, or an environment that already names an instance, is refused.

It gets a superuser account — your account email, and a generated password
printed once (readable afterwards with \`pbc pocketbase info\`). Override
either with --admin-email/--admin-password. --backup restores a PocketBase
backup ZIP instead and preserves its existing superusers.

\`pbc pocketbase deploy\` also creates an instance when there is none, so this
is the explicit form for when there is nothing to package.`,
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
            "Region for the instance, on Starter. The platform picks when omitted.",
        }),
        compute: str({
          description:
            "Compute to create on; asked for when there is a choice, or required " +
            "under --no-input/--json.",
        }),
        server: renamed("compute", {
          description: "Old name for --compute; scripts may keep using it.",
        }),
        adminEmail: str({
          description: "Superuser login; defaults to your account email.",
        }),
        adminPassword: str({
          description:
            "Superuser password, 12-20 characters. Generated and printed once when omitted.",
        }),
        pbVersion: str({
          description:
            "PocketBase release; defaults to pocketbaseVersion in pbc.json.",
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
        log(deployTargetLine(
          { create: true, name, environment },
          KINDS.pocketbases.label,
        ));

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
          label: "PocketBase",
          checkCommand: "pocketbase",
        });
        reportUrl(final, { log, paths: [{ path: "/_/", label: "admin" }] });
        const reachable = await awaitReachable(client, {
          type: "pocketbase",
          resource: final,
          created: true,
          log,
          progress,
        });
        if (ctx.flags.json) {
          emit(true, {
            ...final,
            environment,
            reachable,
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
          console.log(
            `Recorded in pbc.json as environment "${environment}" — ` +
              `\`pbc pocketbase deploy\` here needs no --name.`,
          );
        }
        return 0;
      },
    }),

    "pocketbase deploy": defineCommand({
      path: ["pocketbase", "deploy"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase deploy [--name <name>|--new <name>] [flags]",
      summary: "Create or redeploy a PocketBase instance.",
      details:
        `Packages pb_public, pb_hooks, and pb_migrations and ships them with the
instance, at the paths recorded in the "build" block of pbc.json. None of the
three is required: a directory that holds none still deploys, creating an
empty instance and saying so. Files matched by .pbcignore in this directory
(gitignore-style lines; *.map is left out by default, "!*.map" keeps them) are
not shipped, and the deploy says how many were left out.

A redeploy ships them too: supported hook files (subdirectories included) go
through the hooks route, which keeps the portal's editor in sync; pb_migrations
is merged with the instance's; pb_public is replaced wholesale. New migrations
are applied by the restart that follows.

A new instance gets a superuser account — your account email and a generated
password printed once (readable afterwards with \`pbc pocketbase info\`).
Override either with --admin-email/--admin-password. Env vars are pushed only
from the dotenv file this environment names; \`pbc deploy --help\` lists the
merge and --delete-missing/--skip-env/--force-env rules.`,
      args: [],
      flags: {
        name: str({
          description:
            "Which existing instance to redeploy; asked for when unbound.",
          conflicts: ["new"],
        }),
        new: str({
          description:
            "Create a new PocketBase with this name. Fails if the name is taken.",
          conflicts: ["name"],
        }),
        location: str({
          description:
            "Region for the deploy, on Starter. The platform picks when omitted.",
        }),
        compute: str({
          description:
            "Compute to create on; asked for when there is a choice, or required " +
            "under --no-input/--json.",
        }),
        server: renamed("compute", {
          description: "Old name for --compute; scripts may keep using it.",
        }),
        adminEmail: str({
          description: "Superuser login; defaults to your account email.",
        }),
        adminPassword: str({
          description:
            "Superuser password, 12-20 characters. Generated and printed once when omitted.",
        }),
        pbVersion: str({
          description:
            "PocketBase release; defaults to pocketbaseVersion in pbc.json.",
        }),
        skipBuild: bool({
          description: "Package without running the build command.",
        }),
        force: bool({
          description:
            "Replace the instance's files even when someone changed them after this directory's revision.",
        }),
        skipEnv: bool({
          description: "Push no env vars this run.",
        }),
        envFile: path({
          description:
            "Dotenv file to push; recorded in pbc.json for this environment.",
        }),
        deleteMissing: bool({
          description: "Remove cloud vars the file does not list.",
        }),
        forceEnv: bool({
          description: "Push even when unchanged since the last push.",
        }),
        zip: str({
          description: "Deploy this archive instead of building the directory.",
        }),
        dryRun: bool({
          description:
            "Build and compare with the instance, then show what would upload without changing anything.",
        }),
        preview: bool({
          description:
            "Deploy to a new preview: a copy of the live instance with its own address. Live is not touched.",
          conflicts: ["new"],
        }),
        previewName: str({
          description:
            "Name of the preview. An open preview with this name gets the deploy; otherwise a new one is made with it. Picked when omitted.",
        }),
        previewSize: str({
          description:
            "How much live data the preview copies: small (about 100 rows per collection, the default), medium (about 1,000) or full (refused for a large database).",
          choices: PREVIEW_SIZES,
        }),
        previewKeepUser: str({
          description:
            "Comma-separated emails of users the preview always keeps, so you can sign in as them.",
        }),
        env: str({
          description:
            "Which pbc.json environment; defaults to the file's default or " +
            "production.",
        }),
        subdomain: retired({
          description: "",
          since: "0.6.0",
          note: "Frontends use uid addresses.",
        }),
      },
      run: async (input, ctx) => {
        await assertDeployableAs(
          "pocketbases",
          { cwd: deps.cwd(), zipPath: input.zip },
        );
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
        log(deployTargetLine(target, KINDS.pocketbases.label));
        if (!target.create) {
          const link = await linkedRepository(client, target.resource.id);
          if (link) console.error(linkedWarning(target.resource.name, link));
        }
        const zipPath = input.zip;
        const data: Record<string, unknown> = { project: p.id };
        if (input.location) data.location = input.location;
        const compute = input.compute;
        if (compute) data.server = compute;
        const askCompute = computeChooser(client, p.id, {
          noInput: ctx.flags.noInput || ctx.flags.json,
          log,
        });

        const bundle = await buildBundle({
          cwd,
          kind: "pocketbases",
          zipPath,
          skipBuild: input.skipBuild === true,
          envFile: input.envFile,
          environment: target.environment,
          log,
          progress,
          archive: target.create || Boolean(zipPath) || input.preview === true,
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
        const entries = bundle.files && committableEntries(bundle.files);
        const index = entries
          ? await (deps.hashIndex ?? HashIndex.load)(cwd)
          : undefined;

        if (input.dryRun) {
          const planned: CommitFilesResult = !target.create && entries
            ? await commitFiles(client, {
              pocketbaseId: target.resource.id,
              entries,
              index,
              replace: replacedDirs(entries),
              dryRun: true,
            }, deps.fetch)
            : { status: "unsupported" };
          const archiveBytes = planned.status === "planned"
            ? 0
            : (await archiveOf(bundle)).length;
          const line = planned.status === "planned"
            ? `Would upload ${describeUpload(planned)}.`
            : `Would ${
              target.create ? `create ${target.name} and ` : ""
            }upload ${bundle.fileName} (${formatSize(archiveBytes)}).`;
          if (ctx.flags.json) {
            emit(true, {
              dryRun: true,
              create: target.create,
              ...(planned.status === "planned"
                ? {
                  upload: planned.upload,
                  uploadBytes: planned.uploadBytes,
                  total: planned.total,
                }
                : { archiveBytes }),
            }, "");
          } else {
            log(`${line} Nothing was changed.`);
          }
          return 0;
        }

        if (input.preview) {
          if (target.create) {
            throw new CliError(
              "A preview copies a live instance. Deploy it to live first.",
              { code: "USAGE" },
            );
          }
          const shipped = await progress.step(
            uploadLabel(bundle),
            async (step) => {
              const result = await deployToPreview(client, {
                baseUrl: auth.extUrl,
                token: auth.userToken,
                fetchFn: deps.fetch,
              }, {
                pocketbaseId: target.resource.id,
                bytes: await archiveOf(bundle),
                name: input.previewName,
                size: input.previewSize as PreviewSize | undefined,
                keepUsers: input.previewKeepUser?.split(",").map((email) =>
                  email.trim()
                ).filter(Boolean),
                onProgress: (f) =>
                  step.update(
                    f < 1
                      ? `Uploading — ${Math.round(f * 100)}%`
                      : "Uploaded — copying live into the preview",
                  ),
              });
              if (result.deploymentId) {
                const dep = await waitForDeployment(result.deploymentId, {
                  baseUrl: auth.backendUrl,
                  token: auth.userToken,
                  fetchFn: deps.fetch,
                });
                if (dep.status === "failed") {
                  throw new CliError(dep.statusMessage, {
                    code: "PLATFORM_ERROR",
                  });
                }
              }
              step.done(`Deployed to preview ${result.preview.name}`);
              return result.preview;
            },
          );
          emit(
            ctx.flags.json,
            {
              preview: shipped.name,
              url: previewUrl(shipped),
              instanceId: shipped.members[0]?.id ?? null,
              expiresAt: shipped.expiresAt,
            },
            [
              `Preview ${shipped.name} runs at ${previewUrl(shipped)}`,
              `Live (${target.resource.name}) was not touched. Crons and email are off on the preview.`,
              `Deploy again: pbc pocketbase deploy --preview --preview-name ${shipped.name}`,
              `Ship it:    pbc pocketbase preview ship --preview ${shipped.name}`,
              `Discard it: pbc pocketbase preview rm --preview ${shipped.name}`,
            ].join("\n"),
          );
          return 0;
        }

        let credentials:
          | { adminUsername: string; adminPassword: string }
          | null = null;
        const { resource, created } = await progress.step(
          bundle.bytes.length > 0 || !bundle.files
            ? uploadLabel(bundle)
            : `Uploading changes from ${bundle.files.length} file(s)`,
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
            const baseRevision = input.force ? undefined : await boundRevision(
              cwd,
              target.environment,
              out.resource.id,
            );
            const committed: CommitFilesResult = !out.created && entries
              ? await commitFiles(client, {
                pocketbaseId: out.resource.id,
                entries,
                index,
                replace: replacedDirs(entries),
                baseRevision,
                git: (await readDeployCommit(cwd)) ?? undefined,
                onProgress: (done, total) =>
                  step.update(`Uploading — ${done}/${total} new file(s)`),
                onUndo: (revision) =>
                  rememberRevision(
                    cwd,
                    target.environment,
                    out.resource,
                    revision,
                  ),
              }, deps.fetch)
              : { status: "unsupported" };
            if (committed.status === "committed") {
              step.done(`Uploaded ${describeUpload(committed)}`);
              return out;
            }
            const { deploymentId } = await deployArchive({
              kind: "pocketbases",
              resourceId: out.resource.id,
              bytes: await archiveOf(bundle),
              baseRevision,
              git: await readDeployCommit(cwd),
              onProgress: (f) =>
                step.update(`Uploading — ${Math.round(f * 100)}%`),
            }, {
              baseUrl: auth.extUrl,
              token: auth.userToken,
              fetchFn: deps.fetch,
            });
            step.update("Uploaded — waiting for the platform to start it");
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
              throw await deploymentFailure(
                client,
                "pocketbases",
                out.resource.id,
                dep.statusMessage,
              );
            }
            step.done(`Uploaded ${bundle.fileName}`);
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
        const revision = await currentRevision(client, resource.id);
        if (revision !== undefined) {
          await rememberRevision(cwd, target.environment, resource, revision);
        }

        if (!created) {
          log(
            hasUploadableDirs
              ? "pb_hooks and pb_public replace the instance's, and " +
                "pb_migrations is merged. New migrations run on the restart " +
                "that follows."
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
          label: "PocketBase",
          checkCommand: "pocketbase",
        });
        const admin = credentials as
          | { adminUsername: string; adminPassword: string }
          | null;
        reportUrl(final, { log, paths: [{ path: "/_/", label: "admin" }] });
        const reachable = await awaitReachable(client, {
          type: "pocketbase",
          resource: final,
          created,
          log,
          progress,
        });
        if (ctx.flags.json) {
          emit(true, {
            ...final,
            environment: target.environment,
            reachable,
            ...(admin ?? {}),
          }, "");
        }
        if (!ctx.flags.json && admin) {
          console.log(
            `Admin login: ${admin.adminUsername} / ${admin.adminPassword}`,
          );
        }
        return 0;
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

    "pocketbase continuous-backup status": defineCommand({
      path: ["pocketbase", "continuous-backup", "status"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase continuous-backup status [--name <instance>]",
      summary: "Show whether continuous backup is on for an instance.",
      details: `Continuous backup streams every database change off-site and
allows a restore to any point in time. A paid plan is required to enable it.`,
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const res = await client.ext(
          "/api/pocketbases/continuous-backup/status",
          { pocketbaseId: found.id },
        );
        if (!res.ok) throw await httpError(res, "Continuous backup status");
        const body = await res.json().catch(() => ({})) as {
          data?: { enabled?: boolean; running?: boolean; restorable?: boolean };
        };
        const status = body.data ?? {};
        const enabled = status.enabled === true;
        const running = status.running === true;
        const restorable = status.restorable === true;
        emit(
          ctx.flags.json,
          { enabled, running, restorable },
          [
            `Enabled: ${enabled ? "yes" : "no"}`,
            `Running: ${running ? "yes" : "no"}`,
            `Restorable: ${restorable ? "yes" : "no"}`,
          ].join("\n"),
        );
        return 0;
      },
    }),

    "pocketbase continuous-backup enable": defineCommand({
      path: ["pocketbase", "continuous-backup", "enable"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase continuous-backup enable [--name <instance>]",
      summary: "Turn on continuous backup for an instance.",
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const res = await client.ext(
          "/api/pocketbases/continuous-backup/enable",
          { pocketbaseId: found.id },
        );
        if (!res.ok) throw await httpError(res, "Continuous backup enable");
        emit(ctx.flags.json, { enabled: true }, "Continuous backup enabled.");
        return 0;
      },
    }),

    "pocketbase continuous-backup disable": defineCommand({
      path: ["pocketbase", "continuous-backup", "disable"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase continuous-backup disable [--name <instance>]",
      summary:
        "Turn off continuous backup for an instance and delete its restore points.",
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const res = await client.ext(
          "/api/pocketbases/continuous-backup/disable",
          { pocketbaseId: found.id },
        );
        if (!res.ok) throw await httpError(res, "Continuous backup disable");
        emit(
          ctx.flags.json,
          { enabled: false },
          "Continuous backup disabled. All restore points were deleted.",
        );
        return 0;
      },
    }),

    "pocketbase email status": defineCommand({
      path: ["pocketbase", "email", "status"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase email status [--name <instance>]",
      summary: "Show managed email status, sender level and usage.",
      details: `Managed email sends the instance's verification, password reset
and sign-in code emails with no mail server setup. Starter and Pro only.`,
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const state = await managedEmailCall(
          client,
          "status",
          found.id,
        ) as ManagedEmailState;
        emit(ctx.flags.json, state, () => describeManagedEmail(state));
        return 0;
      },
    }),

    "pocketbase email enable": defineCommand({
      path: ["pocketbase", "email", "enable"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase email enable [--name <instance>]",
      summary:
        "Turn on managed email and write its SMTP settings into the instance.",
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const state = await managedEmailCall(client, "enable", found.id);
        emit(ctx.flags.json, state, "Managed email enabled.");
        return 0;
      },
    }),

    "pocketbase email disable": defineCommand({
      path: ["pocketbase", "email", "disable"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase email disable [--name <instance>]",
      summary:
        "Turn off managed email. The instance stops sending until you set up SMTP.",
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const state = await managedEmailCall(client, "disable", found.id);
        emit(
          ctx.flags.json,
          state,
          "Managed email turned off. The instance sends no email until you turn it on again or set up your own SMTP.",
        );
        return 0;
      },
    }),

    "pocketbase email reapply": defineCommand({
      path: ["pocketbase", "email", "reapply"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase email reapply [--name <instance>]",
      summary: "Write the managed email SMTP settings into the instance again.",
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const state = await managedEmailCall(client, "reapply", found.id);
        emit(ctx.flags.json, state, "SMTP settings restored on the instance.");
        return 0;
      },
    }),

    "pocketbase email messages": defineCommand({
      path: ["pocketbase", "email", "messages"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase email messages [--name <instance>]",
      summary: "List the instance's recent managed emails.",
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const messages = await managedEmailCall(
          client,
          "messages",
          found.id,
        ) as ManagedEmailMessage[];
        emit(
          ctx.flags.json,
          messages,
          () =>
            messages.length === 0 ? "No emails yet." : renderTable(messages, [
              { header: "SENT", get: (m) => m.created },
              { header: "RECIPIENT", get: (m) => m.recipient },
              { header: "STATUS", get: (m) => m.status },
              { header: "REASON", get: (m) => m.reason },
              { header: "SUBJECT", get: (m) => m.subject },
            ]),
        );
        return 0;
      },
    }),

    "pocketbase email test": defineCommand({
      path: ["pocketbase", "email", "test"],
      needs: ["target:pocketbases", { explicit: true }],
      usage: "pbc pocketbase email test [--name <instance>] [--to <address>]",
      summary: "Send a test email through managed email.",
      details: `Sends the instance's verification template. It counts toward the
daily limit and appears in \`pbc pocketbase email messages\`.`,
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
        to: str({ description: "Recipient. Defaults to your account email." }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input);
        const to = (input as { to?: string }).to;
        const result = await managedEmailCall(
          client,
          "test",
          found.id,
          to ? { to } : {},
        ) as { to: string };
        emit(ctx.flags.json, result, `Test email sent to ${result.to}.`);
        return 0;
      },
    }),

    "pocketbase email sender": defineCommand({
      path: ["pocketbase", "email", "sender"],
      needs: ["target:pocketbases", { explicit: true }],
      usage:
        "pbc pocketbase email sender [--name <instance>] [--sender-name <name> --reply-to <address>]",
      summary: "Show or set the sender name and reply-to address.",
      details: `Without flags, prints them. With both flags, saves them on the
instance. Replies from your users go to the reply-to address.`,
      args: [],
      flags: {
        name: str({
          description: "Which instance. Defaults to the directory binding.",
        }),
        senderName: str({ description: "Name your users see as the sender." }),
        replyTo: str({ description: "Address that receives replies." }),
      },
      run: async (input, ctx) => {
        const { senderName, replyTo } = input as {
          senderName?: string;
          replyTo?: string;
        };
        if ((senderName === undefined) !== (replyTo === undefined)) {
          throw new CliError("Pass both --sender-name and --reply-to.", {
            code: "USAGE",
          });
        }
        const { client, found } = await resolveOne(ctx, input);
        const identity =
          await (senderName !== undefined && replyTo !== undefined
            ? managedEmailCall(client, "identity/update", found.id, {
              senderName,
              senderAddress: replyTo,
            })
            : managedEmailCall(
              client,
              "identity",
              found.id,
            )) as ManagedEmailIdentity;
        emit(ctx.flags.json, identity, () => describeSender(identity));
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
      summary: "Upload every supported hook file in <dir> as a hook.",
      details:
        `Hooks belong to one PocketBase instance. Name it with --name/--id, or let
the directory's pbc.json binding pick it.

PocketBase runs only *.pb.js, but every supported text file beside them
(${HOOK_EXTENSIONS.join(", ")}) is uploaded too, subdirectories
included and keeping their relative path, so a required helper module or data
file resolves on the instance. At most ${MAX_HOOKS_PER_PUSH} files per push.`,
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
        const { client, found, environment } = await resolveOne(ctx, input, {
          args: ctx.args.slice(1),
        });
        const log = ctx.flags.json ? () => {} : (m: string) => console.log(m);
        const base = await boundRevision(deps.cwd(), environment, found.id);
        const link = await linkedRepository(client, found.id);
        if (link) console.error(linkedWarning(found.name, link));
        const { sent, stored } = await pushHooks(
          client,
          found.id,
          dir,
          log,
          base,
          (revision) =>
            rememberRevision(deps.cwd(), environment, found, revision),
          (await readDeployCommit(resolve(deps.cwd(), dir))) ?? undefined,
        );
        const revision = sent > 0
          ? await currentRevision(client, found.id)
          : undefined;
        if (revision !== undefined) {
          await rememberRevision(deps.cwd(), environment, found, revision);
        }
        if (sent === 0) {
          throw new CliError(
            `No supported hook files (${
              HOOK_EXTENSIONS.join(", ")
            }) in ${dir}.`,
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
        "inside a deploy archive run but are not recorded here, so this can read\n" +
        "empty while hooks are live.",
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

interface ManagedEmailState {
  enabled: boolean;
  status: string | null;
  statusReason: string;
  trust: string;
  senderAddress: string;
  limits: { daily: number; monthly: number } | null;
  usage: { today: number; month: number };
}

interface ManagedEmailMessage {
  recipient: string;
  status: string;
  reason: string;
  subject: string;
  created: string;
}

type ManagedEmailAction =
  | "status"
  | "enable"
  | "disable"
  | "reapply"
  | "messages"
  | "identity"
  | "identity/update"
  | "test";

interface ManagedEmailIdentity {
  senderName: string;
  senderAddress: string;
  replyReachable: boolean;
}

async function managedEmailCall(
  client: ICloudClient,
  action: ManagedEmailAction,
  pocketbaseId: string,
  extra: Record<string, string> = {},
): Promise<unknown> {
  const res = await client.ext(`/api/pocketbases/email/${action}`, {
    pocketbaseId,
    ...extra,
  });
  if (!res.ok) throw await httpError(res, `Managed email ${action}`);
  const body = await res.json().catch(() => ({})) as { data?: unknown };
  return body.data ?? {};
}

function describeSender(identity: ManagedEmailIdentity): string {
  return [
    `Sender name: ${identity.senderName}`,
    `Reply-to: ${identity.senderAddress}`,
    ...(identity.replyReachable ? [] : [
      "Replies are not delivered to this address. Set one you read with --reply-to.",
    ]),
  ].join("\n");
}

function usageLine(label: string, used: number, limit?: number): string {
  return `${label}: ${used}${limit ? ` / ${limit}` : ""}`;
}

function describeManagedEmail(state: ManagedEmailState): string {
  const status = state.status ?? "disabled";
  const reason = state.statusReason ? ` (${state.statusReason})` : "";
  return [
    `Status: ${status}${reason}`,
    `Sender level: ${state.trust}`,
    `Sender address: ${state.senderAddress}`,
    usageLine("Sent today", state.usage.today, state.limits?.daily),
    usageLine("Sent this month", state.usage.month, state.limits?.monthly),
  ].join("\n");
}
