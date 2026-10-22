import {
  bool,
  type CmdCtx,
  type Command,
  defineCommand,
  type Need,
  path as pathFlag,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError, httpError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { canPrompt, confirm, select } from "../ui/prompt.ts";
import { makeResourceResolver } from "./resource.ts";
import { KINDS } from "../kinds.ts";
import {
  deployArchive,
  type DeployClientConfig,
  uploadArtifact,
} from "../clients/deployments.ts";

export type PreviewSummary = {
  id: string;
  name: string;
  status: "creating" | "ready" | "failed" | "shipping";
  statusMessage: string;
  expiresAt: string;
  data: "copy" | "empty";
  crons: "off" | "on";
  created: string;
  conflicts?: string[];
  members: {
    id: string;
    kind: "pocketbase";
    previewOf: string;
    baseUrl: string;
    status: string;
  }[];
};

const SHIP_SOURCE = "cli";
const CREATING = "creating";
const FAILED = "failed";

export type PreviewWait = { intervalMs: number; timeoutMs: number };

export const DEFAULT_PREVIEW_WAIT: PreviewWait = {
  intervalMs: 3_000,
  timeoutMs: 10 * 60_000,
};

export async function listPreviews(
  client: ICloudClient,
  pocketbaseId: string,
): Promise<PreviewSummary[]> {
  const res = await client.ext("/api/previews/list", undefined, {
    method: "GET",
    query: { pocketbaseId },
  });
  if (!res.ok) throw await httpError(res, "Previews");
  const body = await res.json().catch(() => ({})) as {
    data?: { previews?: PreviewSummary[] };
  };
  return body.data?.previews ?? [];
}

export function previewUrl(preview: PreviewSummary): string {
  return preview.members[0]?.baseUrl ?? "";
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
        ? `No preview named ${name}. This instance has: ${names}.`
        : `No preview named ${name}. This instance has none.`,
      { code: "NOT_FOUND" },
    );
  }
  if (previews.length === 0) {
    throw new CliError("This instance has no previews.", {
      code: "NOT_FOUND",
      hint: "Create one with `pbc pocketbase deploy --preview`.",
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
  const member = preview.members[0];
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
  pocketbaseId: string,
  previewId: string,
  wait: PreviewWait,
): Promise<PreviewSummary> {
  const deadline = Date.now() + wait.timeoutMs;
  while (true) {
    const preview = (await listPreviews(client, pocketbaseId))
      .find((entry) => entry.id === previewId);
    if (preview && preview.status === FAILED) {
      throw new CliError(preview.statusMessage, { code: "PLATFORM_ERROR" });
    }
    if (preview && preview.status !== CREATING) return preview;
    if (Date.now() > deadline) {
      throw new CliError("The preview is still being created.", {
        code: "TIMEOUT",
        hint: "Check it with `pbc pocketbase preview ls`.",
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

function describe(preview: PreviewSummary): string {
  const status = preview.status === "failed"
    ? `failed: ${preview.statusMessage}`
    : preview.status;
  return `  ${preview.name}  ${status}  ${
    previewUrl(preview)
  }  expires ${preview.expiresAt}`;
}

export function makePbPreviewCommands(
  deps: CloudCmdDeps,
  wait: PreviewWait = DEFAULT_PREVIEW_WAIT,
): Record<string, Command> {
  const { resolveOne } = makeResourceResolver(deps, KINDS.pocketbases);
  const needs: readonly Need[] = ["target:pocketbases", { explicit: true }];
  const targetFlags = {
    name: str({ description: "Which live instance. Asked for when omitted." }),
    id: str({ description: "The live instance's id, alternative to --name." }),
    env: str({ description: "Which pbc.json environment to target." }),
  };
  const previewFlag = {
    preview: str({
      description: "Which preview. Picked when the instance has only one.",
    }),
  };
  const positional = {
    name: "name",
    required: false,
    description: "Positional instance name, alternative to --name/--id",
  };

  const withPreview = async (
    ctx: CmdCtx,
    input: Record<string, unknown>,
    args?: string[],
  ) => {
    const { client, found } = await resolveOne(ctx, input, { needs, args });
    const previews = await listPreviews(client, found.id);
    const preview = await choosePreview(
      ctx,
      previews,
      input.preview as string | undefined,
      deps.io,
    );
    return { client, found, preview };
  };

  const confirmed = (ctx: CmdCtx, question: string) =>
    confirm(question, {
      noInput: ctx.flags.noInput || ctx.flags.json,
      yes: ctx.flags.yes,
      io: deps.io,
    });

  return {
    "pocketbase preview ls": defineCommand({
      path: ["pocketbase", "preview", "ls"],
      usage: "pbc pocketbase preview ls [<name>|--name <name>|--id <id>]",
      summary: "List an instance's previews and their addresses.",
      details:
        `A preview is a short-lived copy of a live instance with its own address.
Create one with \`pbc pocketbase deploy --preview\`, try it, then ship it to live
with \`pbc pocketbase preview ship\` or discard it with \`pbc pocketbase preview rm\`.`,
      needs,
      args: [positional],
      flags: targetFlags,
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input, { needs });
        const previews = await listPreviews(client, found.id);
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
              instanceId: preview.members[0]?.id ?? null,
              expiresAt: preview.expiresAt,
              data: preview.data,
              crons: preview.crons,
            })),
          },
          previews.length > 0
            ? [`Previews of ${found.name}:`, ...previews.map(describe)].join(
              "\n",
            )
            : `${found.name} has no previews. Create one with \`pbc pocketbase deploy --preview\`.`,
        );
        return 0;
      },
    }),

    "pocketbase preview ship": defineCommand({
      path: ["pocketbase", "preview", "ship"],
      usage:
        "pbc pocketbase preview ship [<name>|--name <name>|--id <id>] [--preview <name>] [--yes]",
      summary: "Apply a preview's hooks, migrations and public files to live.",
      details:
        `Ships what changed on the preview since it was made: hooks, migrations
(which then run on live) and pb_public. Live data is never overwritten by the
preview's data. Live restarts once, and the preview is deleted afterwards.
Refused when live changed since the preview was made: bring live's newer files
in with \`pbc pocketbase preview update\` first.`,
      needs,
      args: [positional],
      flags: { ...targetFlags, ...previewFlag },
      run: async (input, ctx) => {
        const { client, found, preview } = await withPreview(ctx, input);
        if (
          !await confirmed(
            ctx,
            `Ship ${preview.name} to ${found.name}? Its migrations run on live.`,
          )
        ) {
          console.error("Aborted.");
          return 0;
        }
        const { deploymentId } = await postPreview<{ deploymentId: string }>(
          client,
          "/api/previews/ship",
          { previewId: preview.id, source: SHIP_SOURCE },
          "Ship",
        );
        emit(
          ctx.flags.json,
          { preview: preview.name, shipped: true, deploymentId },
          `Shipped ${preview.name} to ${found.name}. The preview was deleted.`,
        );
        return 0;
      },
    }),

    "pocketbase preview rm": defineCommand({
      path: ["pocketbase", "preview", "rm"],
      usage:
        "pbc pocketbase preview rm [<name>|--name <name>|--id <id>] [--preview <name>] [--yes]",
      summary: "Discard a preview. Live is not touched.",
      needs,
      args: [positional],
      flags: { ...targetFlags, ...previewFlag },
      run: async (input, ctx) => {
        const { client, preview } = await withPreview(ctx, input);
        if (
          !await confirmed(
            ctx,
            `Discard ${preview.name}? Its instance and data are deleted; its file changes stay as a draft.`,
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
          discardedMessage(preview.name, discarded?.draft),
        );
        return 0;
      },
    }),

    "pocketbase preview update": defineCommand({
      path: ["pocketbase", "preview", "update"],
      usage:
        "pbc pocketbase preview update [<name>|--name <name>|--id <id>] [--preview <name>]",
      summary: "Bring live's newer files into a preview, keeping its changes.",
      details:
        `For a preview made before live changed. Live's newer hooks, migrations and
pb_public files are applied to the preview; files the preview changed stay as
they are, and its data is kept. Edits to different parts of the same file are
combined; edits to the same lines are listed for you to settle with
\`pbc pocketbase preview resolve\`.`,
      needs,
      args: [positional],
      flags: { ...targetFlags, ...previewFlag },
      run: async (input, ctx) => {
        const { client, preview } = await withPreview(ctx, input);
        const { updated, conflicts } = await postPreview<
          { updated: boolean; conflicts: string[] }
        >(
          client,
          "/api/previews/update",
          { previewId: preview.id },
          "Update",
        );
        emit(
          ctx.flags.json,
          { preview: preview.name, updated, conflicts },
          conflicts.length > 0
            ? `${preview.name} has live's latest files except ${conflicts.length} that both sides changed in the same place: ${
              conflicts.join(", ")
            }. Settle each with \`pbc pocketbase preview resolve <file> --mine|--live|--from <path>\`.`
            : updated
            ? `${preview.name} now has live's latest files. Ship it with \`pbc pocketbase preview ship\`.`
            : `${preview.name} already has live's latest files.`,
        );
        return 0;
      },
    }),

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

    "pocketbase preview conflicts": defineCommand({
      path: ["pocketbase", "preview", "conflicts"],
      usage:
        "pbc pocketbase preview conflicts [<name>|--name <name>|--id <id>] [--preview <name>]",
      summary:
        "List the files a preview and live both changed in the same place.",
      details:
        `Updating a preview or reopening a draft combines edits to different parts of a
file by itself. Edits to the same lines are left for you: resolve each with
\`pbc pocketbase preview resolve <file>\`. --out <dir> writes each text file
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
              "Resolve each with `pbc pocketbase preview resolve <file> --mine|--live|--from <path>`.",
            ].join("\n")
            : `${preview.name} has nothing to resolve.`,
        );
        return 0;
      },
    }),

    "pocketbase preview resolve": defineCommand({
      path: ["pocketbase", "preview", "resolve"],
      usage:
        "pbc pocketbase preview resolve <file> (--mine|--live|--from <path>) [--name <name>|--id <id>] [--preview <name>]",
      summary: "Settle one file a preview and live both changed.",
      details:
        `--mine keeps the preview's version, --live takes live's (or deletes the file
when live deleted it), and --from saves the content of a local file you edited.
Shipping waits until no file is left; list them with
\`pbc pocketbase preview conflicts\`.`,
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
            hint:
              "pbc pocketbase preview resolve <file> --mine|--live|--from <path>",
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

    "pocketbase preview extend": defineCommand({
      path: ["pocketbase", "preview", "extend"],
      usage:
        "pbc pocketbase preview extend [<name>|--name <name>|--id <id>] [--preview <name>]",
      summary: "Keep a preview for another full lifetime from now.",
      needs,
      args: [positional],
      flags: { ...targetFlags, ...previewFlag },
      run: async (input, ctx) => {
        const { client, preview } = await withPreview(ctx, input);
        await postPreview(
          client,
          "/api/previews/extend",
          { previewId: preview.id },
          "Extend",
        );
        const [updated] =
          (await listPreviews(client, preview.members[0]?.previewOf ?? ""))
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
