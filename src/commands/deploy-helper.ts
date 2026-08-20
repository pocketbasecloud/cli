import { basename, join } from "@std/path";
import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource, ResourceKind } from "../clients/types.ts";
import { describeSubStatus } from "../deploy-status.ts";
import { CliError, httpError } from "../errors.ts";
import { MAX_ARCHIVE_BYTES } from "../limits.ts";
import type { BuildConfig } from "../config.ts";
import { readLinkFile, readOwnPbJson } from "../config.ts";
import {
  assertConfigured,
  chooseEnvironment,
  entryFor,
  resolveEnvironmentName,
} from "../resolve/environment.ts";
import { canPrompt, prompt, type PromptIO, select } from "../ui/prompt.ts";
import { computeLabel } from "../ui/compute.ts";
import {
  createProgress,
  plainProgress,
  type Progress,
} from "../ui/progress.ts";
import {
  envFileOf,
  mergeEnvBuild,
  resolveBuildConfig,
} from "../build/config.ts";
import { type CommandRunner, packageResource } from "../build/package.ts";
import {
  envDigest,
  envStateKey,
  lastEnvDigest,
  recordEnvDigest,
} from "../env-state.ts";
import { parseDotenv, prunedKeysOf } from "./env.ts";

export type Target = {
  id?: string;
  name?: string;
  /** True when the id came from pb.json, which makes a miss a stale binding. */
  fromBinding: boolean;
  /** The environment this command targets, and where deploy records its result. */
  environment: string;
  /** True when the file configures any environment at all, for error wording. */
  hasEnvironments: boolean;
};

/**
 * Resolve which resource a command targets, in which environment. An explicit
 * `--id`/`--name` always wins; otherwise fall back to the environment's entry
 * in the directory's pb.json, when the file binds this kind.
 *
 * The two options are deploy's, and pull in opposite directions because deploy
 * is the only command that writes the file: it may name an environment that
 * does not exist yet (it creates it), but it must not be run in a directory
 * bound to another kind, since `kind` is shared by every environment there.
 */
export async function resolveTarget(
  token: { id?: string; name?: string },
  kind: ResourceKind,
  cwd: string,
  opts: {
    envFlag?: string;
    /** Deploy: an unconfigured environment is a creation, not a mistake. */
    allowNewEnvironment?: boolean;
    /** Deploy and link: refuse a directory already bound to another kind. */
    strictKind?: boolean;
    /** Deploy: ask which environment when the directory names none yet. */
    askEnvironment?: { noInput: boolean; io?: PromptIO };
  } = {},
): Promise<Target> {
  const link = await readLinkFile(cwd);
  let choice = resolveEnvironmentName(link, { flag: opts.envFlag });
  if (opts.askEnvironment) {
    choice = await chooseEnvironment(choice, link, opts.askEnvironment);
  }
  if (!opts.allowNewEnvironment) assertConfigured(choice, link);
  const environments = Object.keys(link?.environments ?? {});
  if (opts.strictKind && link?.kind && link.kind !== kind) {
    throw new CliError(
      `pb.json is bound to ${link.kind} — deploy ${kind} from a different ` +
        `directory.`,
      2,
    );
  }
  const base = {
    environment: choice.name,
    hasEnvironments: environments.length > 0,
  };
  // When --name is explicit on a deploy and the file already binds this
  // environment to a different name, the user may not realise the binding
  // exists. Error rather than silently overwriting it. Only on deploy paths
  // (allowNewEnvironment) — rm/info/logs target any resource.
  if (opts.allowNewEnvironment && token.name && link?.kind === kind) {
    const envEntry = link.environments?.[choice.name];
    if (envEntry?.name && envEntry.name !== token.name) {
      throw new CliError(
        `pb.json binds environment "${choice.name}" to ${kind} "${envEntry.name}", ` +
        `but --name "${token.name}" was passed. Drop --name to redeploy the bound ` +
        `resource, or deploy from a different directory to create a new one.`,
        2,
      );
    }
  }
  if (token.id || token.name) return { ...token, fromBinding: false, ...base };
  const entry = entryFor(link, kind, choice);
  if (entry) return { id: entry.id, fromBinding: true, ...base };
  return { fromBinding: false, ...base };
}

/**
 * What to say when a deploy has nothing to aim at. Which of the two it is
 * matters: an unconfigured *environment* in a file that has others is a
 * different mistake from a directory that has never been deployed.
 */
export function missingTargetMessage(target: Target, label: string): string {
  return target.hasEnvironments
    ? `Environment "${target.environment}" is not configured — pass --name to ` +
      `create it.`
    : `Pass --name to create the first ${label}, or remove --no-input / --json ` +
      `to be asked interactively.`;
}

/** A directory name turned into something usable as a resource name. */
export function suggestName(cwd: string): string {
  const slug = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "app";
}

/**
 * Fill in a deploy target that neither the command line nor pb.json named.
 *
 * Selecting the *project* already prompts by default, so a bare `deploy` in a
 * fresh directory should finish the same conversation rather than stop halfway
 * with a usage error: pick an existing resource to redeploy, or name a new one.
 * Callers that cannot answer (`--no-input`, no TTY, `--json`) still get the
 * usage error, since a prompt there would hang or corrupt the output.
 */
export async function ensureTarget(
  target: Target,
  o: {
    label: string;
    cwd: string;
    /** Called only on the interactive path, so it costs a request only there. */
    list: () => Promise<Resource[]>;
    noInput: boolean;
    io?: PromptIO;
  },
): Promise<Target> {
  if (target.id || target.name) return target;
  const opts = { noInput: o.noInput, io: o.io };
  if (!canPrompt(opts)) {
    throw new CliError(missingTargetMessage(target, o.label), 2);
  }
  const existing = await o.list();
  const choices: { resource?: Resource }[] = [
    ...existing.map((resource) => ({ resource })),
    {},
  ];
  const picked = existing.length === 0 ? {} : await select(
    `Deploy to which ${o.label}?`,
    choices,
    (c) =>
      c.resource
        ? `${c.resource.name}  ${c.resource.id}  ${c.resource.status}`
        : `Create a new ${o.label}…`,
    opts,
  );
  if (picked.resource) {
    return { ...target, id: picked.resource.id, name: picked.resource.name };
  }
  const suggested = suggestName(o.cwd);
  const answer = await prompt(
    `Name for the new ${o.label} [${suggested}]:`,
    opts,
  );
  return { ...target, name: answer || suggested };
}

/**
 * The compute named on the command line, if any.
 *
 * `--server` was the original spelling and still works: the platform calls the
 * record a server, but nothing a user sees does — the portal, the plan page and
 * this CLI all say "compute" — so the flag was renamed to match. Scripts and CI
 * pinned to the old name keep working rather than failing on an unknown flag.
 */
export function computeFlag(
  raw: Record<string, unknown>,
): string | undefined {
  return (raw.compute ?? raw.server) as string | undefined;
}

/**
 * Refuses a `--location` the platform cannot honour.
 *
 * `--location` only means anything when the platform auto-selects a shared
 * server (no `--compute` on the record), and `deploy-context`'s `locations` is
 * the set of regions that pool actually exists in for the project owner's
 * plan. Anything else — every other region the provider sells, most of which
 * hold no server of ours — creates a record that dies with
 * `noServerAvailable` seconds later. A missing `locations` (older backend) is
 * passed through: it is safer to let the platform answer than to guess here.
 */
export async function validateLocationChoice(
  client: ICloudClient,
  projectId: string,
  location: string,
): Promise<void> {
  const context = await client.deployContext(projectId);
  if (!context.locations || context.locations.includes(location)) return;

  const available = context.locations.length
    ? `Regions with platform servers for this project: ${
      context.locations.join(", ")
    }.`
    : "No region currently has platform servers for this project.";
  throw new CliError(
    `--location "${location}" is not available. ${available} Omit ` +
      `--location and the platform picks the least-loaded one.`,
    2,
  );
}

/**
 * Which compute a new resource is created on, when the command line did not
 * say. Answered from the project OWNER's context, because that is whose
 * compute it is: on a project shared into an organization, a developer — on
 * any plan, including free — deploys onto the owner's compute and against the
 * owner's plan, and cannot list `servers` themselves.
 *
 * Two cases get to choose: a Pro account, whose dedicated compute the platform's
 * auto-selection (platform pool only) never picks, and a project inside an
 * organization, which is force-owned by the org owner and so deploys onto the
 * organization's compute whoever runs the command.
 *
 * Returns `undefined` when the platform should choose — the shared pool is
 * auto-selected by capacity, and naming a compute would only get in the way.
 */
export async function chooseCompute(
  client: ICloudClient,
  projectId: string,
  o: { noInput: boolean; log: (msg: string) => void; io?: PromptIO },
): Promise<string | undefined> {
  const context = await client.deployContext(projectId);
  const isPro = context.ownerPlan === "pro";
  // An org project's owner is the org owner, so the owner's computes below are
  // the organization's — offer them even when the plan lookup says otherwise.
  if (!isPro && !context.organization) return undefined;

  // deploy-context answers newest-first; oldest-first keeps a menu's numbering
  // stable as computes are added, and matches the portal's picker.
  const computes = [...context.servers].reverse();

  if (computes.length === 0) {
    // A Pro deploy has nowhere right to land: auto-selection only considers the
    // platform pool, so continuing would quietly put it on shared compute.
    if (isPro) {
      throw new CliError(
        context.isOwner
          ? "No running compute on this account yet. A new Pro compute takes " +
            "a few minutes to provision — check `pb cloud compute ls`."
          : "The project owner has no running compute yet. Ask them to check " +
            "their Pro compute, then deploy again.",
        3,
      );
    }
    // An organization whose owner is not on Pro has no dedicated compute at
    // all; the shared pool is the right answer, exactly as for a solo account.
    return undefined;
  }

  const label = (s: { id: string; location: string }, i: number) =>
    `${computeLabel(i, s.location)}  ${s.id}`;

  if (computes.length === 1) {
    o.log(`Compute: ${label(computes[0], 0)}.`);
    return computes[0].id;
  }

  if (!canPrompt({ noInput: o.noInput, io: o.io })) {
    throw new CliError(
      `This project has ${computes.length} computes — pass --compute <id>:\n` +
        computes.map((s, i) => `  ${label(s, i)}`).join("\n"),
      2,
    );
  }
  const picked = await select("Deploy to which compute?", computes, label, {
    noInput: o.noInput,
    io: o.io,
  });
  return picked.id;
}

/**
 * `chooseCompute`, asked at most once however often the caller retries.
 *
 * A create can run more than once, and neither a second deploy-context request
 * nor a second identical menu is something the user should sit through.
 */
export function computeChooser(
  client: ICloudClient,
  projectId: string,
  o: { noInput: boolean; log: (msg: string) => void; io?: PromptIO },
): () => Promise<string | undefined> {
  let pending: Promise<string | undefined> | undefined;
  return () => (pending ??= chooseCompute(client, projectId, o));
}

/**
 * The owner to record on a new resource. The platform never infers it: the
 * before-create hooks set `createdBy` from the auth token but read `user` as
 * sent, and `user` is what plan lookup, slot accounting, and the collection's
 * list rule all key off. Missing, the create is rejected outright.
 */
export async function resolveOwnerId(
  client: ICloudClient,
  auth: { userId?: string },
): Promise<string> {
  // Token-based auth (PB_TOKEN) carries no id, so ask the platform.
  return auth.userId || (await client.whoami()).id;
}

/**
 * The superuser account the platform creates inside a new PocketBase instance.
 *
 * Both fields are required: `PocketBaseService.handleAfterCreateHook` refuses
 * the deploy outright when either is blank, and nothing on the platform fills
 * them in — the portal generates them in the browser, so the CLI must too.
 * Written only on the create path, since the platform never rotates them.
 */
export async function resolveAdminCredentials(
  client: ICloudClient,
  flags: { username?: string; password?: string },
): Promise<{ adminUsername: string; adminPassword: string }> {
  const adminPassword = flags.password ?? generatePassword();
  // The password field is 12-20 chars wherever it is validated; an explicit
  // one that cannot be used is better caught here than by the agent.
  if (adminPassword.length < 12 || adminPassword.length > 20) {
    throw new CliError(
      "--admin-password must be 12 to 20 characters.",
      2,
    );
  }
  return {
    adminUsername: flags.username ?? (await client.whoami()).email,
    adminPassword,
  };
}

/** A 20-character password from a shell- and copy-paste-safe alphabet. */
export function generatePassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function findExisting(
  resources: Resource[],
  opts: { id?: string; name?: string },
): Resource | "ambiguous" | null {
  if (opts.id) return resources.find((r) => r.id === opts.id) ?? null;
  if (opts.name) {
    const matches = resources.filter((r) => r.name === opts.name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return "ambiguous";
  }
  return null;
}

/**
 * Resolve a single existing resource by name/id. When the token is missing or
 * ambiguous and a terminal is available, present a selection menu of the
 * existing resources instead of erroring — the same unconditional prompt as
 * project selection, used by the name-or-id OR-lookups that `info`/`rm`/`logs`/
 * `env`/hooks share. A caller that cannot ask (`--no-input`, `--json`, a pipe)
 * still gets the actionable error rather than a menu that would hang or corrupt
 * the output.
 */
export async function resolveExisting(
  resources: Resource[],
  token: { id?: string; name?: string },
  opts: {
    label: string;
    noInput: boolean;
    errorMessage?: string;
    io?: PromptIO;
  },
): Promise<Resource> {
  const found = findExisting(resources, token);
  if (found && found !== "ambiguous") return found;
  if (canPrompt({ noInput: opts.noInput, io: opts.io })) {
    if (resources.length === 0) {
      throw new CliError(`No ${opts.label} found.`, 2);
    }
    return await select(
      `Select a ${opts.label}:`,
      resources,
      (r) => `${r.name}  ${r.id}  ${r.status}`,
      { noInput: opts.noInput, io: opts.io },
    );
  }
  throw new CliError(
    opts.errorMessage ?? "Specify a unique --name or --id.",
    2,
  );
}

export async function deployResource(
  client: ICloudClient,
  kind: ResourceKind,
  projectId: string,
  opts: {
    id?: string;
    name?: string;
    data: Record<string, unknown>;
    /** Merged in on the update path only, e.g. status: "uploading". */
    updateData?: Record<string, unknown>;
    /**
     * Merged in on the create path only, and computed lazily so work that
     * matters solely to a fresh resource — packaging a PocketBase's directories,
     * which the platform reads only at instance creation — is skipped entirely
     * on a redeploy.
     */
    createData?: () => Promise<Record<string, unknown>>;
    /**
     * Run on the update path only, before the request — the mirror of
     * `createData`'s laziness, for a check that applies to an upload but not
     * to a create. A PocketBase archive is the case: creation extracts it
     * wholesale (pb_hooks is a fine seed), while the upload route installs
     * `pb_migrations`/`pb_public` and nothing else.
     */
    beforeUpdate?: () => void | Promise<void>;
    // When the target came from a pb.json binding, a missing resource means the
    // binding is stale: run onStale (to clear it) and error instead of creating.
    requireExisting?: boolean;
    onStale?: () => Promise<void>;
    /** Named in the stale-binding error, so it says which entry went bad. */
    environment?: string;
  },
): Promise<{ resource: Resource; created: boolean }> {
  const existing = findExisting(
    await client.listResources(kind, projectId),
    opts,
  );
  if (existing === "ambiguous") {
    throw new CliError(`Multiple ${kind} named "${opts.name}". Pass --id.`, 2);
  }
  if (existing) {
    await opts.beforeUpdate?.();
    return {
      resource: await client.updateResource(kind, existing.id, {
        ...opts.data,
        ...opts.updateData,
      }),
      created: false,
    };
  }
  if (opts.requireExisting) {
    await opts.onStale?.();
    const where = opts.environment
      ? ` (environment "${opts.environment}")`
      : "";
    throw new CliError(
      `Bound ${kind} ${opts.id}${where} no longer exists — pass --name to ` +
        `recreate.`,
      2,
    );
  }
  const data = { ...opts.data, ...(await opts.createData?.() ?? {}) };
  return {
    resource: await client.createResource(kind, data),
    created: true,
  };
}

export type BundleOptions = {
  cwd: string;
  kind: ResourceKind;
  /** `--zip <file>`: upload this archive as-is, skipping build and packaging. */
  zipPath?: string;
  skipBuild: boolean;
  runtime?: string;
  envFile?: string;
  /** Whose `build` overrides apply on top of the file's base block. */
  environment?: string;
  log: (msg: string) => void;
  /** Reports the build's waits. Defaults to plain lines through `log`. */
  progress?: Progress;
  run?: CommandRunner;
};

export type Bundle = {
  build: BuildConfig;
  bytes: Uint8Array;
  fileName: string;
  /**
   * The archive holds no files, so there is nothing to upload — packaging a
   * PocketBase directory that configures none of `pb_public` / `pb_hooks` /
   * `pb_migrations` is the supported way to deploy a bare instance. Attaching
   * the archive anyway sends 22 bytes of end-of-central-directory, and the
   * platform's `unzip` fails the whole deploy with "zipfile is empty".
   *
   * Always false for `--zip`: that archive is passed through unread.
   */
  empty: boolean;
  /** Suggested startCommand from the packager (Next.js standalone). */
  startCommand?: string;
};

/**
 * Largest archive the platform accepts, re-exported from `../limits.ts` for
 * the import sites that already read it from here. `clients/cloud.ts` reads
 * the same number to explain a 413 — see there for why an archive inside the
 * limit can still be rejected.
 */
export { MAX_ARCHIVE_BYTES };

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Throws when the packaged archive is too large for the platform to accept.
 *
 * Runs before the upload so an over-limit archive fails with its own size in
 * the message, rather than after transferring the whole thing — as a
 * PocketBase field-validation error, or as Cloudflare's 413, whose HTML body
 * carries no usable message at all.
 */
export function assertArchiveWithinLimit(
  bytes: Uint8Array,
  fileName: string,
): void {
  if (bytes.length <= MAX_ARCHIVE_BYTES) return;
  throw new CliError(
    `${fileName} is ${formatMb(bytes.length)}, over the ${
      formatMb(MAX_ARCHIVE_BYTES)
    } limit. Trim the build output (or exclude node_modules and source maps) and deploy again.`,
    2,
  );
}

/**
 * Turns a directory into the archive to upload. Runs before any cloud call so
 * a build or packaging failure never leaves a half-provisioned resource.
 */
export async function buildBundle(o: BundleOptions): Promise<Bundle> {
  if (o.zipPath) {
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(o.zipPath);
    } catch {
      throw new CliError(`--zip file not found: ${o.zipPath}`, 2);
    }
    assertArchiveWithinLimit(bytes, basename(o.zipPath));
    // No inference here: --zip means "do not look at my project", so writing a
    // guessed build block into pb.json would be a surprise.
    const own = await readOwnPbJson(o.cwd);
    return {
      build: mergeEnvBuild(own, o.environment),
      bytes,
      fileName: basename(o.zipPath),
      empty: false,
    };
  }

  const build = await resolveBuildConfig({
    cwd: o.cwd,
    kind: o.kind,
    flags: { runtime: o.runtime, envFile: o.envFile },
    environment: o.environment,
    log: o.log,
  });
  const packed = await packageResource({
    cwd: o.cwd,
    kind: o.kind,
    build,
    skipBuild: o.skipBuild,
    log: o.log,
    progress: o.progress,
    run: o.run,
  });
  assertArchiveWithinLimit(packed.bytes, packed.fileName);
  return {
    build,
    bytes: packed.bytes,
    fileName: packed.fileName,
    empty: packed.fileCount === 0,
    startCommand: packed.startCommand,
  };
}

/** Attach the archive the way the portal does — the service reads both fields. */
export function attachZip(
  data: Record<string, unknown>,
  bundle: Pick<Bundle, "bytes" | "fileName">,
): void {
  data.zipFile = new File([bundle.bytes as BlobPart], bundle.fileName, {
    type: "application/zip",
  });
  data.zipFileSize = bundle.bytes.length;
}

/** Dotenv files that exist to be copied, never to be deployed. */
const ENV_TEMPLATES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.local.example",
];

/**
 * The dotenv files in a directory worth offering as an answer, best first:
 * the one named after the environment, then the bare `.env`, then the rest.
 */
export async function envCandidates(
  cwd: string,
  environment: string,
): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(cwd)) {
      if (!e.isFile || !e.name.startsWith(".env")) continue;
      if (ENV_TEMPLATES.includes(e.name)) continue;
      names.push(e.name);
    }
  } catch {
    return [];
  }
  const rank = (n: string) =>
    n === `.env.${environment}` ? 0 : n === ".env" ? 1 : 2;
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** What a deploy decided to do about env vars. */
export type EnvDecision = {
  /** Absent when there is nothing to upload. */
  push?: { name: string; vars: Record<string, string> };
  /** The value to record for this environment, when this call decided it. */
  record?: string;
};

/**
 * Which dotenv file this deploy pushes, and its contents.
 *
 * Resolved before the first cloud call, so a path that does not exist fails a
 * deploy that has provisioned nothing — the same reason `buildBundle` runs
 * where it does. Nothing is pushed unless a file was named: by `--env-file`, by
 * the environment's `build.envFile`, or by answering the prompt below.
 *
 * `push` and `record` are independent because declining the prompt does both
 * nothing and something — no upload, but an answer worth remembering.
 */
export async function resolveEnvFile(o: {
  cwd: string;
  build: BuildConfig;
  environment: string;
  /** --env-file: wins outright, and a file it names but cannot find is fatal. */
  flag?: string;
  /** --skip-env: resolve nothing, ask nothing. */
  skip: boolean;
  noInput: boolean;
  io?: PromptIO;
}): Promise<EnvDecision> {
  if (o.skip) return {};
  // Truthiness, matching `resolveBuildConfig`: `--env-file ""` names no file,
  // and must not be read as "the file called empty string".
  if (o.flag) {
    return { push: await readEnvFile(o.cwd, o.flag), record: o.flag };
  }
  const configured = envFileOf(o.build);
  if (configured === "") return {}; // Answered "none" already.
  if (configured !== undefined) {
    return { push: await readEnvFile(o.cwd, configured) };
  }

  const opts = { noInput: o.noInput, io: o.io };
  if (!canPrompt(opts)) return {};
  // Nothing to choose between: a directory with no dotenv file has one honest
  // answer, and asking would put a prompt in front of every first deploy. The
  // question comes back if a .env appears later, which is when it matters.
  const candidates = await envCandidates(o.cwd, o.environment);
  if (candidates.length === 0) return {};

  type Choice =
    | { kind: "none" }
    | { kind: "file"; name: string }
    | { kind: "custom" };
  const choices: Choice[] = [
    { kind: "none" },
    ...candidates.map((name): Choice => ({ kind: "file", name })),
    { kind: "custom" },
  ];
  const picked = await select(
    `No env file configured for environment "${o.environment}".`,
    choices,
    (c) =>
      c.kind === "none"
        ? "Don't push env vars"
        : c.kind === "custom"
        ? "Enter a path…"
        : c.name,
    opts,
  );
  if (picked.kind === "none") return { record: "" };
  const name = picked.kind === "custom"
    ? await prompt("Path to the env file:", opts)
    : picked.name;
  // An empty answer to the path prompt is a change of mind, not a filename.
  if (name.length === 0) return { record: "" };
  return { push: await readEnvFile(o.cwd, name), record: name };
}

/**
 * The `build` override a deploy adds to its `upsertEnvironment` entry so this
 * environment's env-file choice is remembered — and only ever the first time.
 *
 * Insert-only: an environment already carrying an `envFile` is never rewritten
 * by a deploy, which is what makes the prompt a once-per-environment question
 * and leaves `--env-file` a one-shot override on an environment that has one.
 * Changing a recorded choice is a hand edit of pb.json, like every other
 * `build` field.
 */
export async function envFileEntry(
  cwd: string,
  environment: string,
  decision: EnvDecision,
  log: (msg: string) => void,
): Promise<{ build?: BuildConfig }> {
  if (decision.record === undefined) return {};
  const own = await readOwnPbJson(cwd);
  if (own.environments?.[environment]?.build?.envFile !== undefined) return {};
  log(
    decision.record === ""
      ? `Recorded "no env file" for "${environment}" in pb.json.`
      : `Recorded envFile "${decision.record}" for "${environment}" in pb.json.`,
  );
  return { build: { envFile: decision.record } };
}

async function readEnvFile(
  cwd: string,
  name: string,
): Promise<{ name: string; vars: Record<string, string> }> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(cwd, name));
  } catch {
    // Naming a file is an instruction, so failing to find it is an error rather
    // than a quiet skip — whether the name came from the flag or from pb.json.
    throw new CliError(`Env file not found: ${name}`, 2);
  }
  return { name, vars: parseDotenv(text) };
}

/**
 * Upserts an already-read dotenv map into the cloud env store.
 *
 * Merge semantics: keys in the file are written, keys only in the cloud are
 * left alone. `--delete-missing` swaps that for the file being the whole
 * truth, removing cloud-only keys. Values are never printed.
 *
 * Unchanged files are not re-uploaded: every push records a digest of what it
 * wrote (see `env-state.ts`), and a deploy whose file still hashes to that
 * digest skips the call. The cache is local and advisory — an unknown target
 * pushes — so the worst a lost or stale state file can do is one redundant
 * upload. `--force-env` pushes regardless, for a store changed from the portal.
 */
export async function pushEnvFile(
  client: ICloudClient,
  o: {
    targetId: string;
    type: "pocketbase" | "backend";
    name: string;
    vars: Record<string, string>;
    /** --delete-missing: drop cloud vars the file does not list. */
    deleteMissing?: boolean;
    /** --force-env: push even when nothing changed since the last push. */
    force?: boolean;
    /** Where the digests are kept; unset uses the file beside the config. */
    statePath?: string;
    log: (msg: string) => void;
    progress?: Progress;
  },
): Promise<void> {
  const count = Object.keys(o.vars).length;
  // An emptied file still means something under --delete-missing: clear them all.
  if (count === 0 && o.deleteMissing !== true) return;

  const key = envStateKey(o.type, o.targetId);
  const digest = await envDigest(o.vars, o.deleteMissing === true);
  if (o.force !== true && await lastEnvDigest(key, o.statePath) === digest) {
    o.log(
      `Env vars unchanged since the last push — skipped ${o.name} ` +
        `(--force-env pushes anyway).`,
    );
    return;
  }

  const progress = o.progress ?? plainProgress(o.log);
  await progress.step(
    `Pushing ${count} env var(s) from ${o.name}`,
    async (step) => {
      const res = await client.ext("/api/env/bulk-set", {
        target_id: o.targetId,
        type: o.type,
        variables: o.vars,
        prune: o.deleteMissing === true,
      });
      if (!res.ok) {
        throw await httpError(res, "Env push");
      }
      const removed = prunedKeysOf(await res.json());
      // Only after the platform accepted it: a failed push must leave the
      // next deploy trying again.
      await recordEnvDigest(key, digest, o.statePath);
      step.done(
        `Pushed ${count} env var(s) from ${o.name}.` +
          (removed.length > 0
            ? ` Removed ${removed.length}: ${removed.join(", ")}.`
            : ""),
      );
    },
  );
}

/** The public URL of a deployed resource, however the platform recorded it. */
function resourceUrl(r: Resource): string | undefined {
  const rec = r as unknown as Record<string, string>;
  return rec.baseUrl ?? (rec.domain ? `https://${rec.domain}` : undefined);
}

/**
 * Names where a deployed resource can now be reached.
 *
 * Printed after every deploy, not only the first one: a redeploy used to end at
 * "… is running" and leave the URL to be looked up in the portal, even though
 * it is the one thing a user wants next.
 */
export function reportUrl(
  resource: Resource,
  o: {
    log: (msg: string) => void;
    /** Further paths worth a line of their own, e.g. a PocketBase dashboard. */
    paths?: { path: string; label: string }[];
  },
): string | undefined {
  const url = resourceUrl(resource);
  if (!url) return undefined;
  o.log(`  ${url}`);
  for (const p of o.paths ?? []) o.log(`  ${url}${p.path} (${p.label})`);
  const custom = customDomainLine(resource);
  if (custom) o.log(`  ${custom}`);
  return url;
}

/**
 * The user's own domain, when one is pointed at this resource.
 *
 * Printed beside the platform URL on every deploy, because it is the address
 * the user's traffic actually arrives on — the platform subdomain is the one
 * they stop using once a custom domain verifies. An unverified one still
 * belongs here, saying so: "it deployed but my domain shows nothing" is
 * exactly the moment the pending state explains itself.
 */
export function customDomainLine(resource: Resource): string | undefined {
  const domain = resource.custom_domain;
  if (!domain) return undefined;
  const status = resource.custom_domain_status;
  const note = status === "verified" || status === undefined || status === ""
    ? "custom domain"
    : `custom domain — ${status}`;
  return `https://${domain} (${note})`;
}

/**
 * Holds until a freshly created resource's domain answers.
 *
 * The platform reports `running` as soon as the container starts, but a new
 * subdomain serves nothing until DNS propagates and its certificate is issued.
 * Returning at `running` therefore hands back a URL that fails for the next
 * minute or two, which reads as a deploy that did not work.
 *
 * Never fatal: an unreachable domain is a wait, not a failure, so the caller's
 * exit code still follows the resource's status. The URL itself is printed by
 * `reportUrl`, which runs on a redeploy too.
 */
export async function awaitReachable(
  client: ICloudClient,
  o: {
    type: "pocketbase" | "backend" | "frontend";
    resource: Resource;
    log: (msg: string) => void;
    progress?: Progress;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<boolean> {
  // Nothing to probe until the platform has recorded a domain.
  if (!resourceUrl(o.resource)) return false;
  const progress = o.progress ?? plainProgress(o.log);
  // The longest wait of a first deploy, and the one with the least to show for
  // itself: DNS and ACME take minutes and report nothing in between.
  return await progress.step(
    "Waiting for it to become reachable",
    async (step) => {
      const deadline = Date.now() + (o.timeoutMs ?? 120_000);
      while (true) {
        if (await isReachable(client, o.type, o.resource.id)) {
          step.done("Reachable.");
          return true;
        }
        if (Date.now() > deadline) {
          step.fail(
            "Not reachable yet — a new domain can take a few more minutes " +
              "while its certificate is issued.",
          );
          return false;
        }
        await new Promise((res) => setTimeout(res, o.intervalMs ?? 5_000));
      }
    },
  );
}

async function isReachable(
  client: ICloudClient,
  type: string,
  id: string,
): Promise<boolean> {
  try {
    const res = await client.ext("/api/domain/verify-reachability", {
      type,
      id,
    });
    // The route answers 200 only once the domain actually served a response;
    // while DNS or the certificate is settling it answers 503.
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false; // A network hiccup mid-propagation is not an answer either.
  }
}

/**
 * The progress a deploy command reports through: animated on a terminal, plain
 * lines when piped, and silent under `--json`, where stdout carries one object
 * and nothing else may touch it.
 */
export function deployProgress(json: boolean): Progress {
  return createProgress({ silent: json });
}

/** What the upload step says while an archive is in flight. */
export function uploadLabel(
  bundle: Pick<Bundle, "fileName" | "bytes">,
): string {
  return `Uploading ${bundle.fileName} (${formatMb(bundle.bytes.length)})`;
}

/**
 * The provisioning wait, shown as one step that follows the platform's own
 * status rather than a line per change.
 *
 * This is the longest silence in a deploy — a backend is built into an image,
 * started, and put behind Caddy — so the step keeps the elapsed time visible
 * and names the status the platform last reported. It closes as failed when the
 * resource settles on anything but `running`, which is what the exit code says
 * too.
 */
export async function awaitDeployment(
  client: ICloudClient,
  kind: ResourceKind,
  resource: Resource,
  o: {
    progress: Progress;
    /** Creating and redeploying look identical from here; say which it is. */
    created: boolean;
    /**
     * Which of the directory's environments this deploy belongs to. Optional
     * because not every create belongs to one: `pb cloud pb create` writes no
     * pb.json, so naming an environment here would claim a binding that does
     * not exist.
     */
    environment?: string;
    /** Human word for the resource, e.g. "backend" / "PocketBase". */
    label: string;
    /** Command group to name for recovery, e.g. "pb" / "backend". */
    checkCommand: string;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<Resource> {
  const head = `${o.created ? "Creating" : "Redeploying"} ${resource.name}` +
    (o.environment ? ` (environment: ${o.environment})` : "");
  return await o.progress.step(head, async (step) => {
    const final = await pollStatus(client, kind, resource.id, {
      terminal: ["running", "error", "failed"],
      timeoutMs: o.timeoutMs ?? 300_000,
      intervalMs: o.intervalMs ?? 3_000,
      label: o.label,
      checkCommand: o.checkCommand,
      onTick: (s) => step.update(`${head} — ${s}`),
    });
    if (final.status === "running") {
      step.done(`${final.name} is ${final.status}`);
    } else {
      // "my-app is error" and nothing else was the whole message here, which
      // left the portal as the only place to find out what happened — and it
      // reads the same fields. `statusMessage` wins when the platform wrote
      // one: it is the only one that can name the file that caused this.
      const reason = final.statusMessage?.trim() ||
        describeSubStatus(final.subStatus);
      step.fail(
        `${final.name} is ${final.status}${reason ? ` — ${reason}` : ""}`,
      );
    }
    return final;
  });
}

export async function pollStatus(
  client: ICloudClient,
  kind: ResourceKind,
  id: string,
  opts: {
    terminal: string[];
    timeoutMs: number;
    intervalMs: number;
    onTick?: (s: string) => void;
    /** Human word for the resource in the timeout message. */
    label?: string;
    /** Command group to name for recovery, e.g. "pb" / "backend". */
    checkCommand?: string;
  },
): Promise<Resource> {
  const deadline = Date.now() + opts.timeoutMs;
  // Only status *changes* are worth a line. Ticking every interval turned a
  // five-minute wait into a hundred identical "status: creating" lines — noise
  // for a person and pure token burn for an agent.
  let reported: string | undefined;
  while (true) {
    const r = await client.getResource(kind, id);
    if (r.status !== reported) {
      reported = r.status;
      opts.onTick?.(r.status);
    }
    if (opts.terminal.includes(r.status)) return r;
    if (Date.now() > deadline) {
      // The resource exists and is still provisioning — say so, and name the
      // commands to check on it or clean it up. Without this the user is left
      // with a non-zero exit, an id they cannot act on, and an orphan they do
      // not know they own.
      const label = opts.label ?? kind;
      const name = r.name ?? id;
      throw new CliError(
        `Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ` +
          `${label} "${name}" (last status: ${r.status}).\n` +
          `It was created and may still be provisioning. Check it with ` +
          `\`pb cloud ${opts.checkCommand ?? kind} info --name ${name}\`, ` +
          `or remove it with \`pb cloud ${
            opts.checkCommand ?? kind
          } rm --name ${name}\`.`,
        5,
      );
    }
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  }
}
