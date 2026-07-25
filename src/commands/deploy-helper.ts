import { basename, join } from "@std/path";
import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource, ResourceKind } from "../clients/types.ts";
import { CliError } from "../errors.ts";
import type { BuildConfig } from "../config.ts";
import { readLinkFile, readOwnPbJson } from "../config.ts";
import {
  assertConfigured,
  chooseEnvironment,
  entryFor,
  resolveEnvironmentName,
} from "../resolve/environment.ts";
import { canPrompt, prompt, type PromptIO, select } from "../ui/prompt.ts";
import {
  envFileOf,
  mergeEnvBuild,
  resolveBuildConfig,
} from "../build/config.ts";
import { type CommandRunner, packageResource } from "../build/package.ts";
import { parseDotenv } from "./env.ts";

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
    : `Pass --name to create the first ${label}.`;
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
 * The owner to record on a new resource. The platform never infers it: the
 * before-create hooks set `createdBy` from the auth token but read `user` as
 * sent, and `user` is what plan lookup, slot accounting, and the collection's
 * list rule all key off. Missing, the create is rejected outright.
 */
export async function resolveOwnerId(
  client: ICloudClient,
  auth: { userId?: string },
): Promise<string> {
  // Token-based auth (PB_TOKEN/PB_URL) carries no id, so ask the platform.
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

/**
 * A DNS label for a resource name: what the frontends collection's `subdomain`
 * pattern (^[a-z0-9]([a-z0-9-]*[a-z0-9])?$, 63 max) will accept.
 */
export function toSubdomain(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "site";
}

export function isSubdomain(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value) && value.length <= 63;
}

/** Subdomains are globally unique across frontends and backends. */
export function subdomainTaken(e: unknown): boolean {
  return e instanceof CliError &&
    e.fields?.subdomain === "validation_not_unique";
}

/** A second candidate for a taken subdomain, still within the 63-char limit. */
export function suffixSubdomain(base: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${base.slice(0, 63 - rand.length - 1).replace(/-+$/, "")}-${rand}`;
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
 * ambiguous and `interactive` is set, present a selection menu of the existing
 * resources instead of erroring — the "custom" interactive path for the
 * name-or-id OR-lookups that `info`/`rm`/`logs`/`env` use.
 */
export async function resolveExisting(
  resources: Resource[],
  token: { id?: string; name?: string },
  opts: {
    label: string;
    interactive: boolean;
    noInput: boolean;
    errorMessage?: string;
    io?: PromptIO;
  },
): Promise<Resource> {
  const found = findExisting(resources, token);
  if (found && found !== "ambiguous") return found;
  if (opts.interactive) {
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
  run?: CommandRunner;
};

export type Bundle = {
  build: BuildConfig;
  bytes: Uint8Array;
  fileName: string;
  /** Suggested startCommand from the packager (Next.js standalone). */
  startCommand?: string;
};

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
    // No inference here: --zip means "do not look at my project", so writing a
    // guessed build block into pb.json would be a surprise.
    const own = await readOwnPbJson(o.cwd);
    return {
      build: mergeEnvBuild(own, o.environment),
      bytes,
      fileName: basename(o.zipPath),
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
    run: o.run,
  });
  return {
    build,
    bytes: packed.bytes,
    fileName: packed.fileName,
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

/**
 * Upserts the resource's dotenv file into the cloud env store. Runs by default
 * on every deploy whose directory has one; `--skip-env` opts out.
 *
 * Merge semantics: keys in the file are written, keys only in the cloud are
 * left alone. Values are never printed.
 */
export async function pushEnvFile(
  client: ICloudClient,
  o: {
    targetId: string;
    type: "pocketbase" | "backend";
    cwd: string;
    build: BuildConfig;
    /** True when --env-file named it, which makes a missing file an error. */
    explicit: boolean;
    log: (msg: string) => void;
  },
): Promise<void> {
  const name = envFileOf(o.build);
  let text: string;
  try {
    text = await Deno.readTextFile(join(o.cwd, name));
  } catch {
    if (o.explicit) throw new CliError(`Env file not found: ${name}`, 2);
    return; // No dotenv file is the common case, not a problem.
  }
  const vars = parseDotenv(text);
  const count = Object.keys(vars).length;
  if (count === 0) return;

  const res = await client.ext("/api/env/bulk-set", {
    target_id: o.targetId,
    type: o.type,
    variables: vars,
  });
  if (!res.ok) {
    throw new CliError(`Env push failed (${res.status}).`, 1);
  }
  o.log(`Pushed ${count} env var(s) from ${name}.`);
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
