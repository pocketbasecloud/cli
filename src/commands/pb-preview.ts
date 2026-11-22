import {
  bool,
  type CmdCtx,
  type Command,
  defineCommand,
  type FlagSpec,
  list,
  type Need,
  path as pathFlag,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource } from "../clients/types.ts";
import { CliError, httpError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { canPrompt, confirm, select } from "../ui/prompt.ts";
import { makeResourceResolver } from "./resource.ts";
import { ALL_KINDS, KINDS, type KindSpec } from "../kinds.ts";
import {
  deployArchive,
  type DeployClientConfig,
  uploadArtifact,
} from "../clients/deployments.ts";
import {
  type CopyUpdate,
  type CreatedMember,
  isDiverged,
  isPermanent,
  KIND_WORD,
  listPreviews,
  LIVE,
  MEMBER_KIND_OF,
  pocketbaseMember,
  type PreviewChanges,
  previewChanges,
  type PreviewMember,
  type PreviewSummary,
  type PreviewSync,
  type PreviewUpdate,
  previewUrl,
  sourceLabel,
} from "../clients/previews.ts";

export {
  listPreviews,
  type PreviewMember,
  type PreviewSummary,
  type PreviewSync,
  previewUrl,
} from "../clients/previews.ts";

const SHIP_SOURCE = "cli";
const CREATING = "creating";
const FAILED = "failed";

export type PreviewWait = { intervalMs: number; timeoutMs: number };

export const DEFAULT_PREVIEW_WAIT: PreviewWait = {
  intervalMs: 3_000,
  timeoutMs: 10 * 60_000,
};

function previewCommand(spec: KindSpec): string {
  return `pbc ${spec.noun} preview`;
}

function specOf(preview: PreviewSummary): KindSpec {
  return ALL_KINDS.find((spec) => MEMBER_KIND_OF[spec.kind] === preview.kind) ??
    KINDS.pocketbases;
}

async function postPreview<T>(
  client: ICloudClient,
  path: string,
  body: unknown,
  label: string,
): Promise<T> {
  const res = await client.ext(path, body);
  if (!res.ok) throw await httpError(res, label);
  const json = await res.json().catch(() => ({})) as { data?: T };
  return json.data as T;
}

export function discardedMessage(
  preview: string,
  draft: string | null | undefined,
): string {
  if (draft) {
    return `Discarded ${preview}. Its changes are kept as draft ${draft}: reopen them with \`pbc pocketbase preview reopen --draft ${draft}\`.`;
  }
  if (draft === null) return `Discarded ${preview}. It had no changes to keep.`;
  return `Discarded ${preview}. \`pbc pocketbase preview drafts\` lists any changes it kept.`;
}

async function choosePreview(
  ctx: CmdCtx,
  spec: KindSpec,
  previews: PreviewSummary[],
  name: string | undefined,
  io: CloudCmdDeps["io"],
): Promise<PreviewSummary> {
  const names = previews.map((preview) => preview.name).join(", ");
  if (name) {
    const found = previews.find((preview) => preview.name === name);
    if (found) return found;
    throw new CliError(
      previews.length > 0
        ? `No preview named ${name}. This ${spec.idNoun} has: ${names}.`
        : `No preview named ${name}. This ${spec.idNoun} has none.`,
      {
        code: "NOT_FOUND",
        hint: `${previewCommand(spec)} create ${name}`,
      },
    );
  }
  if (previews.length === 0) {
    throw new CliError(`This ${spec.idNoun} has no previews.`, {
      code: "NOT_FOUND",
      hint: `Create one with \`${previewCommand(spec)} create\`.`,
    });
  }
  if (previews.length === 1) return previews[0];
  const opts = { noInput: ctx.flags.noInput || ctx.flags.json, io };
  if (!canPrompt(opts)) {
    throw new CliError(`Name the preview with --preview: ${names}.`, {
      code: "USAGE",
    });
  }
  return await select(
    "Which preview?",
    previews,
    (preview) => `${preview.name}  ${previewUrl(preview)}`,
    opts,
  );
}

async function refuseTooBigFullCopy(
  client: ICloudClient,
  pocketbaseId: string,
): Promise<void> {
  const res = await client.ext("/api/previews/collections", undefined, {
    method: "GET",
    query: { pocketbaseId, size: "full" },
  });
  if (!res.ok) throw await httpError(res, "Preview");
  const body = await res.json().catch(() => ({})) as {
    data?: { fullCopyRefused?: string | null };
  };
  const refused = body.data?.fullCopyRefused;
  if (refused) {
    throw new CliError(refused, {
      code: "CONFLICT",
      hint: "Pass --preview-size small or --preview-size medium.",
    });
  }
}

export const PREVIEW_SIZES = ["small", "medium", "full"] as const;
const PREVIEW_DATA = ["copy", "empty"] as const;
export type PreviewSize = typeof PREVIEW_SIZES[number];

export async function deployToPreview(
  client: ICloudClient,
  cfg: DeployClientConfig,
  opts: {
    pocketbaseId: string;
    bytes: Uint8Array;
    name?: string;
    size?: PreviewSize;
    keepUsers?: string[];
    onProgress?: (fraction: number) => void;
    wait?: PreviewWait;
  },
): Promise<{ preview: PreviewSummary; deploymentId?: string }> {
  const existing = opts.name
    ? (await listPreviews(client, opts.pocketbaseId)).find((preview) =>
      preview.name === opts.name
    )
    : undefined;
  if (existing) return await deployToExisting(cfg, existing, opts);
  if (opts.size === "full") {
    await refuseTooBigFullCopy(client, opts.pocketbaseId);
  }
  const artifactKey = await uploadArtifact({
    kind: "pocketbases",
    resourceId: opts.pocketbaseId,
    bytes: opts.bytes,
    onProgress: opts.onProgress,
  }, cfg);
  const created = await postPreview<{
    previewId: string;
    deploymentId?: string;
  }>(
    client,
    "/api/previews/create",
    {
      pocketbaseId: opts.pocketbaseId,
      artifactKey,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.size ? { size: opts.size } : {}),
      ...(opts.keepUsers?.length ? { keepUsers: opts.keepUsers } : {}),
    },
    "Preview",
  );
  const preview = await waitForPreview(
    client,
    KINDS.pocketbases,
    opts.pocketbaseId,
    created.previewId,
    opts.wait ?? DEFAULT_PREVIEW_WAIT,
  );
  return { preview, deploymentId: created.deploymentId };
}

async function deployToExisting(
  cfg: DeployClientConfig,
  preview: PreviewSummary,
  opts: { bytes: Uint8Array; onProgress?: (fraction: number) => void },
): Promise<{ preview: PreviewSummary; deploymentId?: string }> {
  const member = pocketbaseMember(preview);
  if (preview.status !== "ready" || !member) {
    throw new CliError(`Preview ${preview.name} is ${preview.status}.`, {
      code: "CONFLICT",
      hint: preview.status === FAILED
        ? `Discard it with \`pbc pocketbase preview rm --preview ${preview.name}\`, or pick another --preview-name.`
        : "Try again once it is ready: `pbc pocketbase preview ls`.",
    });
  }
  const { deploymentId } = await deployArchive({
    kind: "pocketbases",
    resourceId: member.id,
    bytes: opts.bytes,
    onProgress: opts.onProgress,
  }, cfg);
  return { preview, deploymentId };
}

async function waitForPreview(
  client: ICloudClient,
  spec: KindSpec,
  resourceId: string,
  previewId: string,
  wait: PreviewWait,
): Promise<PreviewSummary> {
  const deadline = Date.now() + wait.timeoutMs;
  while (true) {
    const preview =
      (await listPreviews(client, resourceId, MEMBER_KIND_OF[spec.kind]))
        .find((entry) => entry.id === previewId);
    if (preview && preview.status === FAILED) {
      throw new CliError(preview.statusMessage, { code: "PLATFORM_ERROR" });
    }
    if (preview && preview.status !== CREATING) return preview;
    if (Date.now() > deadline) {
      throw new CliError("The preview is still being created.", {
        code: "TIMEOUT",
        hint: `Check it with \`${previewCommand(spec)} ls\`.`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, wait.intervalMs));
  }
}

export type PreviewDraft = {
  id: string;
  name: string;
  previewName: string | null;
  changes: { added: string[]; changed: string[]; removed: string[] };
  updated: string;
};

export async function listDrafts(
  client: ICloudClient,
  pocketbaseId: string,
): Promise<PreviewDraft[]> {
  const res = await client.ext("/api/previews/drafts", undefined, {
    method: "GET",
    query: { pocketbaseId },
  });
  if (!res.ok) throw await httpError(res, "Drafts");
  const body = await res.json().catch(() => ({})) as {
    data?: { drafts?: PreviewDraft[] };
  };
  return body.data?.drafts ?? [];
}

type ConflictFile = {
  path: string;
  text: boolean;
  base: string | null;
  mine: string | null;
  live: string | null;
};

async function writeVersions(
  dir: string,
  conflicts: ConflictFile[],
): Promise<string[]> {
  const written: string[] = [];
  for (const conflict of conflicts.filter((c) => c.text)) {
    if (conflict.path.split("/").includes("..")) continue;
    const target = `${dir}/${conflict.path}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    const versions: [string, string | null][] = [
      [target, conflict.mine],
      [`${target}.live`, conflict.live],
      [`${target}.original`, conflict.base],
    ];
    for (const [file, text] of versions) {
      if (text === null) continue;
      await Deno.writeTextFile(file, text);
      written.push(file);
    }
  }
  return written;
}

function changedFiles(draft: PreviewDraft): number {
  return draft.changes.added.length + draft.changes.changed.length +
    draft.changes.removed.length;
}

export function syncStatus(
  sync: PreviewSync | null | undefined,
  source = LIVE,
): string {
  if (!sync) return "";
  const { added, changed, removed } = sync.ahead;
  const files = `+${added.length} ~${changed.length} -${removed.length}`;
  return sync.behind > 0
    ? `${files}, behind ${source} by ${sync.behind}`
    : `${files}, up to date`;
}

export function lifetimeLabel(preview: PreviewSummary): string {
  return isPermanent(preview) ? "permanent" : `expires ${preview.expiresAt}`;
}

function copyStatus(copy: PreviewMember, source = LIVE): string {
  const status = copy.statusMessage
    ? `${copy.status}: ${copy.statusMessage}`
    : copy.status;
  if (isDiverged(copy)) return `${status}, changed here and on ${source}`;
  const behind = copy.deploys?.behind ?? 0;
  return behind > 0
    ? `${status}, behind ${source} by ${behind} deploy(s)`
    : status;
}

export function describe(preview: PreviewSummary): string {
  const status = preview.status === "failed"
    ? `failed: ${preview.statusMessage}`
    : preview.status;
  const source = sourceLabel(preview);
  const sync = syncStatus(preview.sync, source);
  return [
    `  ${preview.name}  ${status}  ${previewUrl(preview)}  ${
      lifetimeLabel(preview)
    }  from ${source}${sync ? `  ${sync}` : ""}`,
    ...preview.members.map((copy) => copyLine(copy, source)),
  ].join("\n");
}

export function resolveEnvironment(
  previews: PreviewSummary[],
  name: string,
  purpose: "copy" | "ship",
  self?: PreviewSummary,
): typeof LIVE | PreviewSummary {
  if (name === LIVE) return LIVE;
  const environments = previews.filter((preview) =>
    isPermanent(preview) && preview.id !== self?.id
  );
  const choices = [LIVE, ...environments.map((env) => env.name)].join(", ");
  const verb = purpose === "copy" ? "Copy from" : "Ship to";
  const flag = purpose === "copy" ? "--from" : "--to";
  const found = previews.find((preview) =>
    preview.name === name || preview.id === name
  );
  if (found && self && found.id === self.id) {
    throw new CliError(
      `${self.name} can't ship to itself. ${verb} one of: ${choices}.`,
      { code: "USAGE", hint: `${flag} ${LIVE}` },
    );
  }
  if (found && isPermanent(found)) return found;
  throw new CliError(
    found
      ? `${found.name} is a preview, not an environment. ${verb} one of: ${choices}.`
      : `No environment named ${name}. ${verb} one of: ${choices}.`,
    { code: found ? "USAGE" : "NOT_FOUND", hint: `${flag} ${LIVE}` },
  );
}

export function planLines(
  preview: PreviewSummary,
  changes: PreviewChanges,
): string[] {
  const { target, plan, members } = changes;
  const source = sourceLabel(preview);
  const spec = specOf(preview);
  const files = (paths: string[]) => paths.map((path) => `    ${path}`);
  return [
    `Shipping ${preview.name} to ${target.name}:`,
    ...(plan.applied.length > 0
      ? [`  ${plan.applied.length} file(s) applied:`, ...files(plan.applied)]
      : [`  No ${spec.label} file changes to apply.`]),
    ...(plan.targetOnly.length > 0
      ? [
        `  ${plan.targetOnly.length} change(s) on ${target.name} this preview hasn't seen; they'll be kept:`,
        ...files(plan.targetOnly),
      ]
      : []),
    ...(plan.sourceOnly.length > 0
      ? [
        `  Copied from ${source}, which has ${plan.sourceOnly.length} change(s) ${target.name} doesn't. Ship ${source} to ${target.name} first if this change depends on them:`,
        ...files(plan.sourceOnly),
      ]
      : []),
    ...(plan.conflicts.length > 0
      ? [
        `  ${plan.conflicts.length} file(s) changed in the same place on both; shipping stops until each is settled with \`${
          previewCommand(spec)
        } resolve <file> --preview ${preview.name} --mine|--live|--from <path>\`:`,
        ...files(plan.conflicts),
      ]
      : []),
    ...members.map((member) =>
      `  ${KIND_WORD[member.kind]}  ${member.name}  ${member.action}${
        member.message ? `: ${member.message}` : ""
      }`
    ),
  ];
}

export type ShipOutcome = {
  id: string;
  kind: PreviewMember["kind"];
  outcome: "shipped" | "refused" | "failed" | "skipped";
  message?: string;
  deploymentId?: string;
};

export function shipLines(
  preview: PreviewSummary,
  target: string,
  members: ShipOutcome[],
  kept: boolean,
): string[] {
  const names = new Map(preview.members.map((m) => [m.id, m.name]));
  return [
    `Shipped ${preview.name} to ${target}.`,
    ...members.map((member) =>
      `  ${KIND_WORD[member.kind]}  ${
        names.get(member.id) ?? member.id
      }  ${member.outcome}${member.message ? `: ${member.message}` : ""}`
    ),
    !kept
      ? "The preview was deleted."
      : isPermanent(preview)
      ? `${preview.name} is a permanent environment and is kept.`
      : `${preview.name} is kept, so you can ship it on to live later.`,
  ];
}

export function parseEnvOverride(
  spec: string,
): { resource?: string; key: string; value: string } {
  const eq = spec.indexOf("=");
  const colon = spec.lastIndexOf(":", eq);
  const start = colon + 1;
  if (eq < start + 1 || colon === 0) {
    throw new CliError(
      `Invalid --set-env ${JSON.stringify(spec)}. Write KEY=VALUE.`,
      { code: "USAGE", hint: "--set-env API_KEY=value" },
    );
  }
  return {
    ...(colon > 0 ? { resource: spec.slice(0, colon) } : {}),
    key: spec.slice(start, eq),
    value: spec.slice(eq + 1),
  };
}

export function envOverrides(
  found: Pick<Resource, "id" | "name">,
  specs: string[],
): Record<string, Record<string, string>> {
  if (specs.length === 0) return {};
  const values: Record<string, string> = {};
  for (const spec of specs) {
    const { resource, key, value } = parseEnvOverride(spec);
    if (resource && resource !== found.id && resource !== found.name) {
      throw new CliError(
        `--set-env ${spec} names ${resource}, but this copies ${found.name}. Write KEY=VALUE.`,
        { code: "USAGE", hint: `--set-env ${key}=${value}` },
      );
    }
    values[key] = value;
  }
  return { [found.id]: values };
}

function copyLine(copy: PreviewMember, source = LIVE): string {
  return [
    `    ${KIND_WORD[copy.kind]}  ${copy.name}  ${copy.baseUrl || "-"}  ${
      copyStatus(copy, source)
    }`,
    ...(copy.notice ? [`      ${copy.notice}`] : []),
  ].join("\n");
}

export function createdCopies(
  preview: PreviewSummary,
  created: CreatedMember[] | undefined,
): (CreatedMember & { name: string })[] {
  const listed = created ?? preview.members;
  const names = new Map(preview.members.map((m) => [m.id, m.name]));
  return listed.map(({ id, kind, previewOf }) => ({
    id,
    kind,
    previewOf,
    name: names.get(id) ?? id,
  }));
}

export function updateLines(
  preview: PreviewSummary,
  result: PreviewUpdate,
): string[] {
  const source = sourceLabel(preview);
  const command = previewCommand(specOf(preview));
  const names = new Map(preview.members.map((m) => [m.id, m.name]));
  const envCopied = result.envCopied.filter((entry) => entry.keys.length > 0);
  return [
    result.conflicts.length > 0
      ? `Files: merged the source's newer files except ${result.conflicts.length} that both sides changed in the same place: ${
        result.conflicts.join(", ")
      }. Settle each with \`${command} resolve <file> --preview ${preview.name} --mine|--live|--from <path>\`.`
      : result.updated
      ? `Files: merged the source's newer files from ${source}.`
      : `Files: ${preview.name} already has the source's newer files.`,
    ...(result.dataCopied ? [`Data: copied ${source}'s data again.`] : []),
    ...envCopied.map((entry) =>
      `Env: copied ${entry.keys.join(", ")} onto ${
        names.get(entry.memberId) ?? entry.memberId
      }.`
    ),
    ...result.envFailed.map((entry) => `Env: ${entry.message}`),
    ...result.members.map((member) =>
      copyUpdateLine(member, names.get(member.id) ?? member.id, source)
    ),
  ];
}

function copyUpdateLine(
  member: CopyUpdate,
  name: string,
  source: string,
): string {
  if (member.diverged && member.outcome === "skipped") {
    return `Kept: ${name} keeps its own deploys. Take ${source}'s with --replace; its build stays in history.`;
  }
  if (member.diverged && member.outcome === "updated") {
    return `Replaced: ${name} now runs ${source}'s build. Its own deploy stays in its history; roll back brings it back.`;
  }
  if (member.outcome === "updated") {
    return `Redeployed: ${name} from ${source}.`;
  }
  return `${name}: ${member.message ?? member.outcome}`;
}

const ENV_STATE_LABEL: Record<string, string> = {
  missing: "only on live",
  different: "differs from live",
  extra: "only on the copy",
};

export function makePreviewCommands(
  deps: CloudCmdDeps,
  wait: PreviewWait = DEFAULT_PREVIEW_WAIT,
): Record<string, Command> {
  return Object.assign(
    {},
    ...ALL_KINDS.map((spec) => makeKindPreviewCommands(deps, spec, wait)),
  );
}

function makeKindPreviewCommands(
  deps: CloudCmdDeps,
  spec: KindSpec,
  wait: PreviewWait,
): Record<string, Command> {
  const { resolveOne } = makeResourceResolver(deps, spec);
  const needs: readonly Need[] = [`target:${spec.kind}`, { explicit: true }];
  const kind = MEMBER_KIND_OF[spec.kind];
  const isPocketBase = spec.kind === "pocketbases";
  const command = previewCommand(spec);
  const noun = spec.noun;
  const targetFlags = {
    name: str({
      description: `Which live ${spec.idNoun}. Asked for when omitted.`,
    }),
    id: str({
      description: `The live ${spec.idNoun}'s id, alternative to --name.`,
    }),
    env: str({ description: "Which pbc.json environment to target." }),
  };
  const previewFlag = {
    preview: str({
      description:
        `Which preview. Picked when the ${spec.idNoun} has only one.`,
    }),
  };
  const positional = {
    name: "name",
    required: false,
    description: `Positional ${spec.idNoun} name, alternative to --name/--id`,
  };
  const previewArg = {
    name: "preview",
    required: false,
    description: `Which preview. Picked when the ${spec.idNoun} has only one.`,
  };

  const withPreview = async (
    ctx: CmdCtx,
    input: Record<string, unknown>,
    args?: string[],
  ) => {
    const { client, found } = await resolveOne(ctx, input, { needs, args });
    const previews = await listPreviews(client, found.id, kind);
    const preview = await choosePreview(
      ctx,
      spec,
      previews,
      input.preview as string | undefined,
      deps.io,
    );
    return { client, found, preview, previews };
  };

  const confirmed = (ctx: CmdCtx, question: string) =>
    confirm(question, {
      noInput: ctx.flags.noInput || ctx.flags.json,
      yes: ctx.flags.yes,
      io: deps.io,
    });

  const onlyCopy = (preview: PreviewSummary): PreviewMember => {
    const copy = preview.members.find((member) => member.kind === kind);
    if (copy) return copy;
    throw new CliError(`${preview.name} has no copy of a ${spec.label}.`, {
      code: "NOT_FOUND",
      hint: `${command} ls`,
    });
  };

  const sizeFlag = {
    size: str({
      description:
        "How much live data to copy: small (the default), medium or full.",
      choices: PREVIEW_SIZES,
    }),
  };
  const dataFlag = {
    data: str({
      description:
        "Copy live's data (copy, the default) or start with an empty database (empty).",
      choices: PREVIEW_DATA,
    }),
  };

  const copyCommands: Record<string, Command> = isPocketBase ? {} : {
    [`${noun} preview env-diff`]: defineCommand({
      path: [noun, "preview", "env-diff"],
      usage: `${command} env-diff [<preview>] [--name <name>|--id <id>]`,
      summary:
        `List the env keys a preview of a ${spec.label} has that differ from live.`,
      details: `Lists key names only, never values. Copy live's values over with
\`${command} env-copy\`.`,
      needs,
      args: [previewArg],
      flags: targetFlags,
      run: async (input, ctx) => {
        const { client, preview } = await withPreview(
          ctx,
          { ...input, preview: ctx.args[0] },
          [],
        );
        const member = onlyCopy(preview);
        const res = await client.ext("/api/previews/env-diff", undefined, {
          method: "GET",
          query: { previewId: preview.id, memberId: member.id },
        });
        if (!res.ok) throw await httpError(res, "Env diff");
        const body = await res.json().catch(() => ({})) as {
          data?: { keys?: { key: string; state: string }[] };
        };
        const keys = body.data?.keys ?? [];
        emit(
          ctx.flags.json,
          { preview: preview.name, member: member.name, keys },
          keys.length > 0
            ? [
              `${member.name} in ${preview.name} differs from live:`,
              ...keys.map((entry) =>
                `  ${entry.key}  ${ENV_STATE_LABEL[entry.state] ?? entry.state}`
              ),
              `Copy live's values with \`${command} env-copy ${preview.name}\`.`,
            ].join("\n")
            : `${member.name} in ${preview.name} has the same env as live.`,
        );
        return 0;
      },
    }),

    [`${noun} preview env-copy`]: defineCommand({
      path: [noun, "preview", "env-copy"],
      usage:
        `${command} env-copy [<preview>] [--key <KEY> ...] [--name <name>|--id <id>] [--yes]`,
      summary: `Copy env values from live onto a preview of a ${spec.label}.`,
      details:
        `Copies live's values for the named keys (every key when --key is omitted). A
service restarts; a website is rebuilt when its source was kept.`,
      needs,
      args: [previewArg],
      flags: {
        ...targetFlags,
        key: list({
          description: "Copy only this key. Repeatable.",
        }),
      },
      run: async (input, ctx) => {
        const { client, preview } = await withPreview(
          ctx,
          { ...input, preview: ctx.args[0] },
          [],
        );
        const member = onlyCopy(preview);
        const keys = input.key ?? [];
        if (
          !await confirmed(
            ctx,
            `Copy ${
              keys.length > 0 ? keys.join(", ") : "every env value"
            } from live onto ${member.name} in ${preview.name}?`,
          )
        ) {
          console.error("Aborted.");
          return 0;
        }
        const result = await postPreview<{ copied: string[] }>(
          client,
          "/api/previews/env-copy",
          {
            previewId: preview.id,
            memberId: member.id,
            ...(keys.length > 0 ? { keys } : {}),
          },
          "Env copy",
        );
        const copied = result?.copied ?? [];
        emit(
          ctx.flags.json,
          { preview: preview.name, member: member.name, copied },
          copied.length > 0
            ? `Copied ${
              copied.join(", ")
            } from live onto ${member.name} in ${preview.name}.`
            : `Nothing to copy: ${member.name} in ${preview.name} already matches live.`,
        );
        return 0;
      },
    }),
  };

  const updateFlags: Record<string, FlagSpec> = isPocketBase
    ? {
      data: bool({
        description:
          "Also copy the source's data again, replacing the preview's data.",
      }),
    }
    : {
      copyEnv: bool({
        description: "Also copy env keys that differ from the source.",
      }),
      replace: bool({
        description:
          "Take the source's build even when the preview has deploys of its own.",
      }),
    };

  const pocketbaseCommands: Record<string, Command> = !isPocketBase ? {} : {
    "pocketbase preview drafts": defineCommand({
      path: ["pocketbase", "preview", "drafts"],
      usage: "pbc pocketbase preview drafts [<name>|--name <name>|--id <id>]",
      summary: "List the changes kept from an instance's previews.",
      details:
        `Every file change made on a preview is kept as a draft on its live instance,
even after the preview is discarded or expires. Reopen one as a new preview
with \`pbc pocketbase preview reopen --draft <name>\`.`,
      needs,
      args: [positional],
      flags: targetFlags,
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input, { needs });
        const drafts = await listDrafts(client, found.id);
        emit(
          ctx.flags.json,
          { id: found.id, drafts },
          drafts.length > 0
            ? [
              `Drafts of ${found.name}:`,
              ...drafts.map((draft) =>
                `  ${draft.name}  ${changedFiles(draft)} file(s) changed  ${
                  draft.previewName
                    ? `open as ${draft.previewName}`
                    : "no open preview"
                }  updated ${draft.updated}`
              ),
            ].join("\n")
            : `${found.name} has no drafts.`,
        );
        return 0;
      },
    }),
    "pocketbase preview reopen": defineCommand({
      path: ["pocketbase", "preview", "reopen"],
      usage:
        "pbc pocketbase preview reopen [<name>|--name <name>|--id <id>] --draft <name>",
      summary: "Open a draft as a new preview on top of the latest live.",
      details:
        `Makes a new preview from live, as \`deploy --preview\` does with the default
Small copy, then applies the draft's file changes to it. Files live also changed
in the same place are listed for \`pbc pocketbase preview resolve\`.`,
      needs,
      args: [positional],
      flags: {
        ...targetFlags,
        draft: str({ description: "Which draft, by name." }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input, { needs });
        const drafts = await listDrafts(client, found.id);
        const name = input.draft as string | undefined;
        const draft = drafts.find((entry) => entry.name === name);
        if (!draft) {
          throw new CliError(
            name
              ? `No draft named ${name}. Drafts: ${
                drafts.map((entry) => entry.name).join(", ") || "none"
              }.`
              : "Name the draft with --draft.",
            {
              code: name ? "NOT_FOUND" : "USAGE",
              hint: "List them with `pbc pocketbase preview drafts`.",
            },
          );
        }
        const created = await postPreview<{ previewId: string }>(
          client,
          "/api/previews/create",
          { pocketbaseId: found.id, draftId: draft.id },
          "Reopen",
        );
        const preview = await waitForPreview(
          client,
          spec,
          found.id,
          created.previewId,
          wait,
        );
        emit(
          ctx.flags.json,
          {
            preview: preview.name,
            url: previewUrl(preview),
            conflicts: preview.conflicts ?? [],
          },
          [
            `Reopened ${draft.name} as ${preview.name}: ${previewUrl(preview)}`,
            ...((preview.conflicts ?? []).length > 0
              ? [
                `Live also changed these in the same place: ${
                  preview.conflicts!.join(", ")
                }. Settle each with \`pbc pocketbase preview resolve <file>\`.`,
              ]
              : []),
          ].join("\n"),
        );
        return 0;
      },
    }),

    "pocketbase preview drafts rename": defineCommand({
      path: ["pocketbase", "preview", "drafts", "rename"],
      usage:
        "pbc pocketbase preview drafts rename <draft> <new-name> [--name <name>|--id <id>]",
      summary: "Rename a draft so you can find it later.",
      needs,
      args: [
        {
          name: "draft",
          required: true,
          description: "The draft's current name",
        },
        {
          name: "new-name",
          required: true,
          description: "Lowercase letters, numbers and hyphens",
        },
      ],
      flags: targetFlags,
      run: async (input, ctx) => {
        const [current, next] = ctx.args;
        if (!current || !next) {
          throw new CliError("Name the draft and its new name.", {
            code: "USAGE",
            hint: "pbc pocketbase preview drafts rename <draft> <new-name>",
          });
        }
        const { client, found } = await resolveOne(ctx, input, {
          needs,
          args: [],
        });
        const drafts = await listDrafts(client, found.id);
        const draft = drafts.find((entry) => entry.name === current);
        if (!draft) {
          throw new CliError(
            `No draft named ${current}. Drafts: ${
              drafts.map((entry) => entry.name).join(", ") || "none"
            }.`,
            { code: "NOT_FOUND" },
          );
        }
        await postPreview(
          client,
          "/api/previews/drafts/rename",
          { draftId: draft.id, name: next },
          "Rename",
        );
        emit(
          ctx.flags.json,
          { draft: next, previous: current },
          `Renamed draft ${current} to ${next}.`,
        );
        return 0;
      },
    }),
  };

  return {
    [`${noun} preview ls`]: defineCommand({
      path: [noun, "preview", "ls"],
      usage: `${command} ls [<name>|--name <name>|--id <id>]`,
      summary:
        `List a ${spec.label}'s previews and environments with their addresses.`,
      details:
        `A preview is a short-lived copy of a live ${spec.label} with its own address. A
permanent environment such as staging is the same copy that never expires.
Create one with \`${command} create\`${
          isPocketBase ? "\nor `pbc pocketbase deploy --preview`" : ""
        }, try it, then ship it to live with
\`${command} ship\` or discard it with \`${command} rm\`.`,
      needs,
      args: [positional],
      flags: targetFlags,
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input, { needs });
        const previews = await listPreviews(client, found.id, kind);
        emit(
          ctx.flags.json,
          {
            id: found.id,
            previews: previews.map((preview) => ({
              id: preview.id,
              name: preview.name,
              status: preview.status,
              statusMessage: preview.statusMessage,
              url: previewUrl(preview),
              instanceId: pocketbaseMember(preview)?.id ?? null,
              lifetime: preview.lifetime,
              expiresAt: preview.expiresAt,
              data: preview.data,
              crons: preview.crons,
              sync: preview.sync ?? null,
              copiedFrom: preview.copiedFrom ?? null,
              members: preview.members,
            })),
          },
          previews.length > 0
            ? [
              `Previews of ${found.name}:`,
              ...previews.map(describe),
              ...(previews.some((preview) => (preview.sync?.behind ?? 0) > 0)
                ? [
                  `A preview behind its source is missing the source's newer files: \`${command} update\` brings them in.`,
                ]
                : []),
            ].join("\n")
            : `${found.name} has no previews. Create one with \`${command} create\`.`,
        );
        return 0;
      },
    }),

    [`${noun} preview create`]: defineCommand({
      path: [noun, "preview", "create"],
      usage:
        `${command} create [<preview>] [--name <name>|--id <id>] [--from live|<environment>] [--permanent] [--set-env KEY=VALUE ...]${
          isPocketBase ? " [--data copy|empty] [--size small|medium|full]" : ""
        }`,
      summary:
        `Copy a live ${spec.label} into a preview or permanent environment.`,
      details:
        `Copies the live ${spec.label} and its env, with its own address. A preview
expires; --permanent makes a lasting environment such as staging. Per
${spec.label}: Free 1 preview; Starter 2 previews and 1 environment; Pro
25 previews and unlimited environments.

--from <environment> copies a permanent environment instead of live.${
          isPocketBase
            ? "\n--data empty starts from an empty database instead of live's data."
            : ""
        }
--set-env KEY=VALUE overrides one copied env value. Repeatable.
Deploy to the copy from the live ${spec.label}'s directory with
\`pbc ${noun} deploy --env <preview>\`.`,
      needs,
      args: [{
        name: "preview",
        required: false,
        description: "Name of the preview or environment. Picked when omitted.",
      }],
      flags: {
        name: targetFlags.name,
        id: targetFlags.id,
        from: str({
          description:
            "Copy this permanent environment instead of live (the default).",
        }),
        permanent: bool({
          description:
            "Keep it as a permanent environment that never expires (Starter and Pro).",
        }),
        setEnv: list({
          description: "KEY=VALUE env override on the copy. Repeatable.",
        }),
        ...(isPocketBase ? { ...dataFlag, ...sizeFlag } : {}),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(
          ctx,
          { name: input.name, id: input.id },
          { needs, args: [] },
        );
        const env = envOverrides(found, input.setEnv ?? []);
        const source = input.from
          ? resolveEnvironment(
            await listPreviews(client, found.id, kind),
            input.from,
            "copy",
          )
          : LIVE;
        const size = (input as { size?: PreviewSize }).size;
        const data = (input as { data?: string }).data;
        if (size === "full" && data !== "empty") {
          await refuseTooBigFullCopy(client, found.id);
        }
        const name = ctx.args[0];
        const created = await postPreview<
          { previewId: string; members?: CreatedMember[] }
        >(
          client,
          "/api/previews/create",
          {
            kind,
            resourceId: found.id,
            lifetime: input.permanent ? "permanent" : "preview",
            ...(name ? { name } : {}),
            ...(source === LIVE ? {} : { from: source.id }),
            ...(data ? { data } : {}),
            ...(size ? { size } : {}),
            ...(Object.keys(env).length > 0 ? { env } : {}),
          },
          input.permanent ? "Environment" : "Preview",
        );
        const preview = await waitForPreview(
          client,
          spec,
          found.id,
          created.previewId,
          wait,
        );
        const label = isPermanent(preview) ? "Environment" : "Preview";
        const copies = createdCopies(preview, created.members);
        emit(
          ctx.flags.json,
          {
            preview: preview.name,
            url: previewUrl(preview),
            lifetime: preview.lifetime,
            expiresAt: preview.expiresAt,
            copiedFrom: preview.copiedFrom ?? null,
            members: preview.members,
            copies,
          },
          [
            `${label} ${preview.name} of ${found.name}, copied from ${
              sourceLabel(preview)
            }, is ready (${lifetimeLabel(preview)}):`,
            ...copies.map((copy) =>
              `    ${KIND_WORD[copy.kind]}  ${copy.name}  ${copy.id}`
            ),
            `Deploy to it: pbc ${noun} deploy --env ${preview.name} (from its directory)`,
            `Ship it:      ${command} ship --preview ${preview.name}`,
          ].join("\n"),
        );
        return 0;
      },
    }),

    ...copyCommands,

    [`${noun} preview ship`]: defineCommand({
      path: [noun, "preview", "ship"],
      usage:
        `${command} ship [<name>|--name <name>|--id <id>] [--preview <name>] [--to live|<environment>] [--yes]`,
      summary:
        "Apply a preview's changes to live or to a permanent environment.",
      details: `Ships only what changed on the preview since it was copied${
        isPocketBase
          ? ": hooks, migrations\n(which then run on the target) and pb_public"
          : ""
      }.
--to picks live or a permanent environment such as staging; the default is
where the preview was copied from. The target's own newer changes are
kept, and its data and env are never overwritten. The plan is printed first.
Files both sides changed in the same place stop the ship until settled with
\`${command} resolve\`. Shipped to live, a preview is deleted;
shipped to an environment, it is kept so it can go on to live later.`,
      needs,
      args: [positional],
      flags: {
        ...targetFlags,
        ...previewFlag,
        to: str({
          description:
            "Ship to live or a permanent environment. Defaults to where the preview was copied from.",
        }),
      },
      run: async (input, ctx) => {
        const { client, preview, previews } = await withPreview(ctx, input);
        const target = input.to
          ? resolveEnvironment(previews, input.to, "ship", preview)
          : undefined;
        const to = target === undefined
          ? undefined
          : target === LIVE
          ? LIVE
          : target.id;
        const changes = await previewChanges(client, preview.id, to);
        console.error(planLines(preview, changes).join("\n"));
        if (
          !await confirmed(
            ctx,
            `Ship ${preview.name} to ${changes.target.name}?${
              isPocketBase
                ? ` Its migrations run on ${changes.target.name}.`
                : ""
            }`,
          )
        ) {
          console.error("Aborted.");
          return 0;
        }
        const shipped = await postPreview<
          { deploymentId: string; members?: ShipOutcome[]; kept?: boolean }
        >(
          client,
          "/api/previews/ship",
          {
            previewId: preview.id,
            source: SHIP_SOURCE,
            ...(to ? { to } : {}),
          },
          "Ship",
        );
        const members = shipped?.members ?? [];
        const kept = shipped?.kept ?? isPermanent(preview);
        emit(
          ctx.flags.json,
          {
            preview: preview.name,
            shipped: true,
            target: changes.target,
            plan: changes.plan,
            deploymentId: shipped?.deploymentId,
            kept,
            members,
          },
          shipLines(preview, changes.target.name, members, kept).join("\n"),
        );
        return 0;
      },
    }),

    [`${noun} preview rm`]: defineCommand({
      path: [noun, "preview", "rm"],
      usage:
        `${command} rm [<name>|--name <name>|--id <id>] [--preview <name>] [--yes]`,
      summary: "Discard a preview. Live is not touched.",
      needs,
      args: [positional],
      flags: { ...targetFlags, ...previewFlag },
      run: async (input, ctx) => {
        const { client, preview } = await withPreview(ctx, input);
        if (
          !await confirmed(
            ctx,
            isPocketBase
              ? `Discard ${preview.name}? Its instance and data are deleted; its file changes stay as a draft.`
              : `Discard ${preview.name}? Its copy is deleted.`,
          )
        ) {
          console.error("Aborted.");
          return 0;
        }
        const discarded = await postPreview<{ draft?: string | null }>(
          client,
          "/api/previews/discard",
          { previewId: preview.id },
          "Discard",
        );
        emit(
          ctx.flags.json,
          { preview: preview.name, discarded: true, draft: discarded?.draft },
          isPocketBase
            ? discardedMessage(preview.name, discarded?.draft)
            : `Discarded ${preview.name}.`,
        );
        return 0;
      },
    }),

    [`${noun} preview update`]: defineCommand({
      path: [noun, "preview", "update"],
      usage:
        `${command} update [<name>|--name <name>|--id <id>] [--preview <name>] ${
          isPocketBase ? "[--data]" : "[--copy-env] [--replace]"
        } [--yes]`,
      summary:
        "Bring the source's newer files into a preview, keeping its changes.",
      details: isPocketBase
        ? `For a preview made before its source (live or the environment it was copied
from) changed. The source's newer hooks, migrations and pb_public files are
applied to the preview; files the preview changed stay as they are, and its data
is kept. Edits to different parts of the same file are combined; edits to the
same lines are listed for you to settle with \`${command} resolve\`.

--data also copies the source's data again, replacing the preview's data.`
        : `For a preview made before its source (live or the environment it was copied
from) changed. A preview behind its source is redeployed from it. One with
deploys of its own keeps them unless you pass --replace; its build stays in its
deploy history, so roll back brings it back.

--copy-env also copies the env keys that differ from the source.`,
      needs,
      args: [positional],
      flags: { ...targetFlags, ...previewFlag, ...updateFlags },
      run: async (input, ctx) => {
        const options = input as {
          data?: boolean;
          copyEnv?: boolean;
          replace?: boolean;
        };
        const { client, preview } = await withPreview(ctx, {
          name: input.name,
          id: input.id,
          preview: input.preview,
        });
        const replace = options.replace ? [onlyCopy(preview).id] : [];
        if (
          options.data &&
          !await confirmed(
            ctx,
            `Replace ${preview.name}'s data with a new copy of ${
              sourceLabel(preview)
            }'s data?`,
          )
        ) {
          console.error("Aborted.");
          return 0;
        }
        const response = await postPreview<Partial<PreviewUpdate>>(
          client,
          "/api/previews/update",
          {
            previewId: preview.id,
            ...(options.data ? { data: true } : {}),
            ...(options.copyEnv ? { env: true } : {}),
            ...(replace.length > 0 ? { replace } : {}),
          },
          "Update",
        );
        const result: PreviewUpdate = {
          updated: response?.updated ?? false,
          conflicts: response?.conflicts ?? [],
          dataCopied: response?.dataCopied ?? false,
          envCopied: response?.envCopied ?? [],
          envFailed: response?.envFailed ?? [],
          members: response?.members ?? [],
        };
        emit(
          ctx.flags.json,
          { preview: preview.name, ...result },
          updateLines(preview, result).join("\n"),
        );
        return 0;
      },
    }),

    ...pocketbaseCommands,
    [`${noun} preview conflicts`]: defineCommand({
      path: [noun, "preview", "conflicts"],
      usage:
        `${command} conflicts [<name>|--name <name>|--id <id>] [--preview <name>]`,
      summary:
        "List the files a preview and live both changed in the same place.",
      details:
        `Updating a preview or reopening a draft combines edits to different parts of a
file by itself. Edits to the same lines are left for you: resolve each with
\`${command} resolve <file>\`. --out <dir> writes each text file
there three times: <path> (yours, edit this one), <path>.live and
<path>.original; then run \`resolve <file> --from <dir>/<path>\`.`,
      needs,
      args: [positional],
      flags: {
        ...targetFlags,
        ...previewFlag,
        out: pathFlag({
          description: "Write the versions of each file to this folder.",
        }),
      },
      run: async (input, ctx) => {
        const { client, preview } = await withPreview(ctx, input);
        const res = await client.ext("/api/previews/conflicts", undefined, {
          method: "GET",
          query: { previewId: preview.id },
        });
        if (!res.ok) throw await httpError(res, "Conflicts");
        const body = await res.json().catch(() => ({})) as {
          data?: { conflicts?: ConflictFile[] };
        };
        const conflicts = body.data?.conflicts ?? [];
        const written = input.out
          ? await writeVersions(input.out as string, conflicts)
          : [];
        emit(
          ctx.flags.json,
          { preview: preview.name, conflicts, written },
          conflicts.length > 0
            ? [
              `${conflicts.length} file(s) in ${preview.name} need resolving:`,
              ...conflicts.map((c) =>
                `  ${c.path}${c.text ? "" : "  (not text: --mine or --live)"}`
              ),
              `Resolve each with \`${command} resolve <file> --mine|--live|--from <path>\`.`,
            ].join("\n")
            : `${preview.name} has nothing to resolve.`,
        );
        return 0;
      },
    }),

    [`${noun} preview resolve`]: defineCommand({
      path: [noun, "preview", "resolve"],
      usage:
        `${command} resolve <file> (--mine|--live|--from <path>) [--name <name>|--id <id>] [--preview <name>]`,
      summary: "Settle one file a preview and live both changed.",
      details:
        `--mine keeps the preview's version, --live takes live's (or deletes the file
when live deleted it), and --from saves the content of a local file you edited.
Shipping waits until no file is left; list them with
\`${command} conflicts\`.`,
      needs,
      args: [{
        name: "file",
        required: true,
        description: "Path such as pb_hooks/main.pb.js",
      }],
      flags: {
        ...targetFlags,
        ...previewFlag,
        mine: bool({
          description: "Keep the preview's version.",
          conflicts: ["live", "from"],
        }),
        live: bool({
          description: "Take live's version.",
          conflicts: ["mine", "from"],
        }),
        from: pathFlag({
          description: "Save this local file's content.",
          conflicts: ["mine", "live"],
        }),
      },
      run: async (input, ctx) => {
        const file = ctx.args[0];
        const take = input.mine
          ? "mine"
          : input.live
          ? "live"
          : input.from
          ? "content"
          : null;
        if (!file || !take) {
          throw new CliError("Name the file and how to settle it.", {
            code: "USAGE",
            hint: `${command} resolve <file> --mine|--live|--from <path>`,
          });
        }
        const { client, preview } = await withPreview(ctx, input, []);
        const content = take === "content"
          ? await Deno.readTextFile(input.from as string)
          : undefined;
        await postPreview(
          client,
          "/api/previews/resolve",
          {
            previewId: preview.id,
            path: file,
            take,
            ...(content === undefined ? {} : { content }),
          },
          "Resolve",
        );
        emit(
          ctx.flags.json,
          { preview: preview.name, path: file, resolved: take },
          `Resolved ${file} in ${preview.name}.`,
        );
        return 0;
      },
    }),

    [`${noun} preview extend`]: defineCommand({
      path: [noun, "preview", "extend"],
      usage:
        `${command} extend [<name>|--name <name>|--id <id>] [--preview <name>]`,
      summary: "Keep a preview for another full lifetime from now.",
      needs,
      args: [positional],
      flags: { ...targetFlags, ...previewFlag },
      run: async (input, ctx) => {
        const { client, found, preview } = await withPreview(ctx, input);
        if (isPermanent(preview)) {
          throw new CliError(
            `${preview.name} is a permanent environment: it does not expire, so there is nothing to extend.`,
            {
              code: "CONFLICT",
              hint: `${command} ship --preview ${preview.name}`,
            },
          );
        }
        await postPreview(
          client,
          "/api/previews/extend",
          { previewId: preview.id },
          "Extend",
        );
        const [updated] = (await listPreviews(client, found.id, kind))
          .filter((entry) => entry.id === preview.id);
        emit(
          ctx.flags.json,
          { preview: preview.name, expiresAt: updated?.expiresAt ?? null },
          `${preview.name} now expires ${updated?.expiresAt ?? "later"}.`,
        );
        return 0;
      },
    }),
  };
}
