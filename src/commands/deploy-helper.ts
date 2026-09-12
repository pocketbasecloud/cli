import { basename, join } from "@std/path";
import type { ICloudClient } from "../clients/cloud.ts";
import type { Project, Resource, ResourceKind } from "../clients/types.ts";
import { describeSubStatus } from "../deploy-status.ts";
import { CliError, httpError } from "../errors.ts";
import type { KindSpec } from "../kinds.ts";
import { nearestCommand } from "../parse.ts";
import { MAX_ARCHIVE_BYTES } from "../limits.ts";
import type { BuildConfig } from "../config.ts";
import {
  bindingFileName,
  linkFileName,
  portalUrl,
  readLinkFile,
  readOwnLinkFile,
} from "../config.ts";
import {
  assertConfigured,
  chooseEnvironment,
  entryFor,
  resolveEnvironmentName,
} from "../resolve/environment.ts";
import { chooseFromMenu } from "../ui/menu.ts";
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
  fromBinding: boolean;
  environment: string;
  hasEnvironments: boolean;
};

export async function resolveEnvironmentTarget(
  token: { name?: string },
  kind: ResourceKind,
  cwd: string,
  opts: {
    envFlag?: string;
    allowNewEnvironment?: boolean;
    strictKind?: boolean;
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
      `${await bindingFileName(cwd)} is bound to ${link.kind} — deploy ` +
        `${kind} from a different directory.`, { code: "USAGE" });
  }
  const base = {
    environment: choice.name,
    hasEnvironments: environments.length > 0,
  };
  if (opts.allowNewEnvironment && token.name && link?.kind === kind) {
    const envEntry = link.environments?.[choice.name];
    if (envEntry?.name && envEntry.name !== token.name) {
      throw new CliError(
        `${await bindingFileName(cwd)} binds environment "${choice.name}" to ` +
          `${kind} "${envEntry.name}", but --name "${token.name}" was passed. ` +
          `Drop --name to redeploy the bound resource, or deploy from a ` +
          `different directory to create a new one.`,
        { code: "CONFLICT" },
      );
    }
  }
  if (token.name) return { name: token.name, fromBinding: false, ...base };
  const entry = entryFor(link, kind, choice);
  if (entry) return { id: entry.id, fromBinding: true, ...base };
  return { fromBinding: false, ...base };
}

export type DeployIntent =
  & { environment: string; hasEnvironments: boolean }
  & (
    | { create: false; resource: Resource; fromBinding: boolean }
    | { create: true; name: string }
  );

export async function resolveDeployIntent(
  target: Target,
  o: {
    client: ICloudClient;
    spec: KindSpec;
    projectId: string;
    cwd: string;
    newName?: string;
    noInput: boolean;
    io?: PromptIO;
    onStale?: () => Promise<unknown>;
  },
): Promise<DeployIntent> {
  const noun = o.spec.noun;
  const label = o.spec.label;
  const list = await o.client.listResources(o.spec.kind, {
    project: o.projectId,
  });
  const base = {
    environment: target.environment,
    hasEnvironments: target.hasEnvironments,
  };
  const match = (tok: string): Resource | null => {
    const byId = list.find((r) => r.id === tok);
    if (byId) return byId;
    const byName = list.filter((r) => r.name === tok);
    if (byName.length > 1) {
      throw new CliError(
        `More than one ${label} is named "${tok}". Pass its id.`,
        { code: "CONFLICT" },
      );
    }
    return byName[0] ?? null;
  };

  if (o.newName) {
    if (target.name) {
      throw new CliError(
        `Cannot deploy to both "${target.name}" and --new ${o.newName}. ` +
          `Name the target with one or the other.`,
        { code: "USAGE", hint: `pbc ${noun} deploy <name>` },
      );
    }
    if (match(o.newName)) {
      throw new CliError(
        `${label} "${o.newName}" already exists — redeploy it with ` +
          `--name ${o.newName}.`,
        {
          code: "CONFLICT",
          hint: `pbc ${noun} deploy --name ${o.newName}`,
        },
      );
    }
    return { ...base, create: true, name: o.newName };
  }

  if (target.fromBinding && target.id) {
    const found = list.find((r) => r.id === target.id);
    if (found) return { ...base, create: false, resource: found, fromBinding: true };
    await o.onStale?.();
    throw new CliError(
      `The ${label} bound to environment "${target.environment}" no longer ` +
        `exists. Recreate it with --new <name>.`,
      { code: "NOT_FOUND", hint: `pbc ${noun} deploy --new <name>` },
    );
  }

  if (target.name) {
    const found = match(target.name);
    if (found) {
      return { ...base, create: false, resource: found, fromBinding: false };
    }
    const near = nearestCommand(target.name, list.map((r) => r.name));
    throw new CliError(
      `No ${label} named "${target.name}".` +
        (near ? ` Did you mean "${near}"?` : "") +
        ` Create it with --new ${target.name}.`,
      {
        code: "NOT_FOUND",
        hint: `pbc ${noun} deploy --new ${target.name}`,
      },
    );
  }

  const opts = { noInput: o.noInput, io: o.io };
  if (!canPrompt(opts)) {
    throw new CliError(
      `No deploy target. This directory has no pbc.json binding.\n` +
        `  redeploy one:  pbc ${noun} deploy <name>\n` +
        `  create one:    pbc ${noun} deploy --new <name>\n` +
        `  list them:     pbc ${noun} ls`,
      { code: "NO_TARGET", hint: `pbc ${noun} ls` },
    );
  }
  if (list.length > 0) {
    const projects = new Map(
      (await o.client.listProjects()).map((p) => [p.id, p.name]),
    );
    const choice = await chooseFromMenu({
      items: list,
      label,
      verb: "Deploy to",
      allowCreate: true,
      key: (r) => ({
        name: r.name,
        id: r.id,
        status: r.status,
        project: projects.get(r.project),
        updated: r.updated,
      }),
      opts,
    });
    if (!choice.create) {
      return {
        ...base,
        create: false,
        resource: choice.item,
        fromBinding: false,
      };
    }
  }
  const suggested = suggestName(o.cwd);
  const answer = await prompt(
    `Name for the new ${label} [${suggested}]:`,
    opts,
  );
  return { ...base, create: true, name: answer || suggested };
}

export function suggestName(cwd: string): string {
  const slug = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "app";
}

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
      { code: "USAGE" });
}

export async function chooseCompute(
  client: ICloudClient,
  projectId: string,
  o: { noInput: boolean; log: (msg: string) => void; io?: PromptIO },
): Promise<string | undefined> {
  const context = await client.deployContext(projectId);
  const isPro = context.ownerPlan === "pro";
  if (!isPro && !context.organization) return undefined;

  const computes = [...context.servers].reverse();

  if (computes.length === 0) {
    if (isPro) {
      throw new CliError(
        context.isOwner
          ? "No running compute on this account yet. A new Pro compute takes " +
            "a few minutes to provision — check `pbc compute ls`."
          : "The project owner has no running compute yet. Ask them to check " +
            "their Pro compute, then deploy again.",
        { code: "NOT_FOUND", hint: "pbc compute ls" },
      );
    }
    return undefined;
  }

  const label = (
    s: { id: string; location: string; shortKey?: string },
    i: number,
  ) => `${computeLabel(i, s.location, s.shortKey)}  ${s.id}`;

  if (computes.length === 1) {
    o.log(`Compute: ${label(computes[0], 0)}.`);
    return computes[0].id;
  }

  if (!canPrompt({ noInput: o.noInput, io: o.io })) {
    throw new CliError(
      `This project has ${computes.length} computes — pass --compute <id>:\n` +
        computes.map((s, i) => `  ${label(s, i)}`).join("\n"),
        { code: "USAGE" });
  }
  const picked = await select("Deploy to which compute?", computes, label, {
    noInput: o.noInput,
    io: o.io,
  });
  return picked.id;
}

export function computeChooser(
  client: ICloudClient,
  projectId: string,
  o: { noInput: boolean; log: (msg: string) => void; io?: PromptIO },
): () => Promise<string | undefined> {
  let pending: Promise<string | undefined> | undefined;
  return () => (pending ??= chooseCompute(client, projectId, o));
}

function planPageUrl(): string {
  return `${portalUrl().replace(/\/login\/?$/, "")}/plan`;
}

export async function ensureBackendProject(
  client: ICloudClient,
  project: Project,
  o: { noInput: boolean; io?: PromptIO; log: (msg: string) => void },
): Promise<Project> {
  const rejected = new Set<string>();
  let current = project;
  while (true) {
    const { ownerPlan } = await client.deployContext(current.id);
    if (ownerPlan === "pro") return current;
    rejected.add(current.id);

    const reason =
      `Project "${current.name}" is on the ${ownerPlan} plan, which cannot ` +
      `host a backend — backends run on a Pro organization's compute.`;
    const others = (await client.listProjects()).filter(
      (p) => !rejected.has(p.id),
    );

    if (!canPrompt({ noInput: o.noInput, io: o.io }) || others.length === 0) {
      throw new CliError(
        `${reason} ${
          others.length === 0
            ? `Upgrade at ${planPageUrl()}, or deploy from a project owned by ` +
              `a Pro organization.`
            : `Re-run with --project <name> for a project owned by a Pro ` +
              `organization, or upgrade at ${planPageUrl()}.`
        }`,
        { code: "USAGE" },
      );
    }

    o.log(reason);
    current = await select(
      "Deploy the backend into which project instead?",
      others,
      (p) => `${p.name} (${p.id})`,
      { noInput: o.noInput, io: o.io },
    );
  }
}

export async function resolveOwnerId(
  client: ICloudClient,
  auth: { userId?: string },
): Promise<string> {
  return auth.userId || (await client.whoami()).id;
}

export async function resolveAdminCredentials(
  client: ICloudClient,
  flags: { username?: string; password?: string },
): Promise<{ adminUsername: string; adminPassword: string }> {
  const adminPassword = flags.password ?? generatePassword();
  if (adminPassword.length < 12 || adminPassword.length > 20) {
    throw new CliError(
      "--admin-password must be 12 to 20 characters.", { code: "USAGE" });
  }
  return {
    adminUsername: flags.username ?? (await client.whoami()).email,
    adminPassword,
  };
}

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

export async function deployResource(
  client: ICloudClient,
  kind: ResourceKind,
  intent: DeployIntent,
  opts: {
    data: Record<string, unknown>;
    updateData?: Record<string, unknown>;
    createData?: () => Promise<Record<string, unknown>>;
    beforeUpdate?: () => void | Promise<void>;
  },
): Promise<{ resource: Resource; created: boolean }> {
  if (!intent.create) {
    await opts.beforeUpdate?.();
    return {
      resource: await client.updateResource(kind, intent.resource.id, {
        ...opts.data,
        ...opts.updateData,
      }),
      created: false,
    };
  }
  const data = {
    ...opts.data,
    name: intent.name,
    ...(await opts.createData?.() ?? {}),
  };
  return {
    resource: await client.createResource(kind, data),
    created: true,
  };
}

export type BundleOptions = {
  cwd: string;
  kind: ResourceKind;
  zipPath?: string;
  skipBuild: boolean;
  runtime?: string;
  envFile?: string;
  environment?: string;
  log: (msg: string) => void;
  progress?: Progress;
  run?: CommandRunner;
};

export type Bundle = {
  build: BuildConfig;
  bytes: Uint8Array;
  fileName: string;
  empty: boolean;
  startCommand?: string;
};

export { MAX_ARCHIVE_BYTES };

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function assertArchiveWithinLimit(
  bytes: Uint8Array,
  fileName: string,
): void {
  if (bytes.length <= MAX_ARCHIVE_BYTES) return;
  throw new CliError(
    `${fileName} is ${formatMb(bytes.length)}, over the ${
      formatMb(MAX_ARCHIVE_BYTES)
    } limit. Trim the build output (or exclude node_modules and source maps) and deploy again.`,
    { code: "USAGE" });
}

export async function buildBundle(o: BundleOptions): Promise<Bundle> {
  if (o.zipPath) {
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(o.zipPath);
    } catch {
      throw new CliError(
        `--zip file not found: ${o.zipPath}`,
        { code: "USAGE" },
      );
    }
    assertArchiveWithinLimit(bytes, basename(o.zipPath));
    const own = await readOwnLinkFile(o.cwd);
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

const ENV_TEMPLATES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.local.example",
];

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

export type EnvDecision = {
  push?: { name: string; vars: Record<string, string> };
  record?: string;
};

export async function resolveEnvFile(o: {
  cwd: string;
  build: BuildConfig;
  environment: string;
  flag?: string;
  skip: boolean;
  noInput: boolean;
  io?: PromptIO;
}): Promise<EnvDecision> {
  if (o.skip) return {};
  if (o.flag) {
    return { push: await readEnvFile(o.cwd, o.flag), record: o.flag };
  }
  const configured = envFileOf(o.build);
  if (configured === "") return {};
  if (configured !== undefined) {
    return { push: await readEnvFile(o.cwd, configured) };
  }

  const opts = { noInput: o.noInput, io: o.io };
  if (!canPrompt(opts)) return {};
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
  if (name.length === 0) return { record: "" };
  return { push: await readEnvFile(o.cwd, name), record: name };
}

export async function envFileEntry(
  cwd: string,
  environment: string,
  decision: EnvDecision,
  log: (msg: string) => void,
): Promise<{ build?: BuildConfig }> {
  if (decision.record === undefined) return {};
  const own = await readOwnLinkFile(cwd);
  if (own.environments?.[environment]?.build?.envFile !== undefined) return {};
  const name = await linkFileName(cwd);
  log(
    decision.record === ""
      ? `Recorded "no env file" for "${environment}" in ${name}.`
      : `Recorded envFile "${decision.record}" for "${environment}" in ${name}.`,
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
    throw new CliError(`Env file not found: ${name}`, { code: "USAGE" });
  }
  return { name, vars: parseDotenv(text) };
}

export async function pushEnvFile(
  client: ICloudClient,
  o: {
    targetId: string;
    type: "pocketbase" | "backend";
    name: string;
    vars: Record<string, string>;
    deleteMissing?: boolean;
    force?: boolean;
    statePath?: string;
    log: (msg: string) => void;
    progress?: Progress;
  },
): Promise<void> {
  const count = Object.keys(o.vars).length;
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

function resourceUrl(r: Resource): string | undefined {
  const rec = r as unknown as Record<string, string>;
  return rec.baseUrl ?? (rec.domain ? `https://${rec.domain}` : undefined);
}

export function reportUrl(
  resource: Resource,
  o: {
    log: (msg: string) => void;
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

export function customDomainLine(resource: Resource): string | undefined {
  const domain = resource.custom_domain;
  if (!domain) return undefined;
  const status = resource.custom_domain_status;
  const note = status === "verified" || status === undefined || status === ""
    ? "custom domain"
    : `custom domain — ${status}`;
  return `https://${domain} (${note})`;
}

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
  if (!resourceUrl(o.resource)) return false;
  const progress = o.progress ?? plainProgress(o.log);
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
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export function deployProgress(json: boolean): Progress {
  return createProgress({ silent: json });
}

export function uploadLabel(
  bundle: Pick<Bundle, "fileName" | "bytes">,
): string {
  return `Uploading ${bundle.fileName} (${formatMb(bundle.bytes.length)})`;
}

export async function awaitDeployment(
  client: ICloudClient,
  kind: ResourceKind,
  resource: Resource,
  o: {
    progress: Progress;
    created: boolean;
    environment?: string;
    label: string;
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
    label?: string;
    checkCommand?: string;
  },
): Promise<Resource> {
  const deadline = Date.now() + opts.timeoutMs;
  let reported: string | undefined;
  while (true) {
    const r = await client.getResource(kind, id);
    if (r.status !== reported) {
      reported = r.status;
      opts.onTick?.(r.status);
    }
    if (opts.terminal.includes(r.status)) return r;
    if (Date.now() > deadline) {
      const label = opts.label ?? kind;
      const name = r.name ?? id;
      const checkCommand = opts.checkCommand ?? kind;
      throw new CliError(
        `Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ` +
          `${label} "${name}" (last status: ${r.status}).\n` +
          `It was created and may still be provisioning. Check it with ` +
          `\`pbc ${checkCommand} info --name ${name}\`, ` +
          `or remove it with \`pbc ${checkCommand} rm --name ${name}\`.`,
        {
          code: "TIMEOUT",
          hint: `pbc ${checkCommand} info --name ${name}`,
        },
      );
    }
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  }
}
