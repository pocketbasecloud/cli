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
      usage: "pbc pocketbase deploy [--name <name>|--new <name>] [flags]",
      summary: "Create or redeploy a PocketBase instance.",
      details:
        `Packages pb_public, pb_hooks, and pb_migrations and ships them with the
instance, at the paths recorded in the "build" block of pbc.json. None of the
three is required: a directory that holds none still deploys, creating an
empty instance and saying so.

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
          description:
            "Deploy this archive instead of building the directory.",
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
        const { client, found } = await resolveOne(ctx, input, {
          args: ctx.args.slice(1),
        });
        const log = ctx.flags.json ? () => {} : (m: string) => console.log(m);
        const { sent, stored } = await pushHooks(client, found.id, dir, log);
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
