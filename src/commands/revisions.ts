import { basename, dirname, join, resolve } from "@std/path";
import {
  bool,
  type CmdCtx,
  type Command,
  defineCommand,
  type Need,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import type { ResourceKind } from "../clients/types.ts";
import { ALL_KINDS, type KindSpec } from "../kinds.ts";
import { CliError, httpError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { extractFiles } from "../local/unzip.ts";
import { linkFilePath, readOwnLinkFile, upsertEnvironment } from "../config.ts";
import { makeResourceResolver } from "./resource.ts";
import { linkedRepository, linkedWarning } from "../clients/repo-link.ts";
import { waitForDeployment } from "../clients/deployments.ts";
import { deploymentFailure } from "./deploy-helper.ts";

const REVISION_DIRS = ["pb_hooks", "pb_migrations", "pb_public"];
const MAX_EXPORT_BYTES = 200 * 1024 * 1024;
const MAX_LISTED_PATHS = 5;

const SOURCE_LABELS: Record<string, string> = {
  portal: "portal",
  cli: "cli",
  mcp: "ai assistant",
  archive: "archive",
  github: "github",
  instance: "instance",
  rollback: "restore",
  backfill: "history start",
};

type Owner = { kind: ResourceKind; id: string };

type Revision = {
  number: number;
  status?: string;
  source: string;
  author?: string;
  gitAuthor?: string;
  message?: string;
  created: string;
};

type Diff = {
  from: number;
  to: number;
  added: { path: string; size: number }[];
  changed: { path: string; size: number; previousSize: number }[];
  removed: { path: string; previousSize: number }[];
};

type RestorePreview = {
  number: number;
  current?: number;
  hooksWritten?: string[];
  hooksRemoved?: string[];
  publicReplaced?: boolean;
  migrationsReverted?: string[];
  schemaBlocker?: string | null;
  filesWritten?: string[];
  filesRemoved?: string[];
};

export function describeRestore(preview: RestorePreview): string[] {
  const lines: string[] = [];
  const hooksWritten = preview.hooksWritten ?? [];
  const hooksRemoved = preview.hooksRemoved ?? [];
  const migrationsReverted = preview.migrationsReverted ?? [];
  if (hooksWritten.length > 0) {
    lines.push(`  write   ${hooksWritten.join(", ")}`);
  }
  if (hooksRemoved.length > 0) {
    lines.push(`  remove  ${hooksRemoved.join(", ")}`);
  }
  if (preview.publicReplaced) lines.push("  replace pb_public");
  if (migrationsReverted.length > 0) {
    lines.push(
      `  revert  ${migrationsReverted.join(", ")} (down parts, newest first)`,
    );
  }
  return lines;
}

export function describeSourceRestore(preview: RestorePreview): string[] {
  const lines: string[] = [];
  const written = preview.filesWritten ?? [];
  const removed = preview.filesRemoved ?? [];
  if (written.length > 0) lines.push(`  write   ${listPaths(written)}`);
  if (removed.length > 0) lines.push(`  remove  ${listPaths(removed)}`);
  return lines;
}

function listPaths(paths: string[]): string {
  const rest = paths.length - MAX_LISTED_PATHS;
  return paths.slice(0, MAX_LISTED_PATHS).join(", ") +
    (rest > 0 ? `, and ${rest} more` : "");
}

async function localLinkFileName(root: string): Promise<string | null> {
  const path = await linkFilePath(root);
  return await readLocal(path) ? basename(path) : null;
}

export function isPullablePath(
  path: string,
  kind: ResourceKind = "pocketbases",
): boolean {
  const segments = path.split("/");
  const inside = kind === "pocketbases"
    ? REVISION_DIRS.includes(segments[0]) && segments.length > 1
    : segments[0] !== "";
  return inside && !path.includes("\\") &&
    segments.slice(1).every((s) => s !== "" && s !== "." && s !== "..") &&
    segments[0] !== "." && segments[0] !== "..";
}

export function authorLabel(author: string | undefined, me: string): string {
  if (!author) return "platform";
  return author === me ? "you" : "teammate";
}

function revisionRoute(owner: Owner, action: string): string {
  return owner.kind === "pocketbases"
    ? `/api/pocketbases/revisions/${action}`
    : `/api/revisions/${action}`;
}

function ownerBody(owner: Owner): Record<string, string> {
  return owner.kind === "pocketbases"
    ? { pocketbaseId: owner.id }
    : { kind: owner.kind, resourceId: owner.id };
}

export type LiveBuild = {
  deploymentId: string;
  created: string;
  via: "cli" | "upload";
};

export function liveBuildLine(build: LiveBuild): string {
  const day = build.created.slice(0, 10);
  const what = build.via === "cli"
    ? `a build uploaded with the CLI on ${day}`
    : `a finished build uploaded on ${day}`;
  return `Live runs ${what}, not this source. The next save in PocketBase Cloud builds this source and replaces it.`;
}

export function buildOverSourceWarning(
  name: string,
  kind: "frontends" | "backends",
): string {
  return `${name} is edited as source in PocketBase Cloud. This build replaces it until the next save there; ${
    kind === "frontends"
      ? "use --source to keep them in sync."
      : "deploy its source from the portal or GitHub to keep them in sync."
  }`;
}

export async function editedAsSource(
  client: ICloudClient,
  kind: "frontends" | "backends",
  id: string,
): Promise<boolean> {
  const res = await client.ext("/api/revisions/list", {
    kind,
    resourceId: id,
    page: 1,
    perPage: 1,
  }).catch(() => null);
  if (!res?.ok) {
    await res?.body?.cancel();
    return false;
  }
  const json = await res.json().catch(() => null) as
    | { data?: { sourceManaged?: boolean; current?: number } }
    | null;
  return json?.data?.sourceManaged === true && json.data.current !== 0;
}

async function revisionCall<T>(
  client: ICloudClient,
  owner: Owner,
  action: string,
  body: Record<string, unknown>,
  label: string,
): Promise<T> {
  const res = await client.ext(revisionRoute(owner, action), {
    ...ownerBody(owner),
    ...body,
  });
  if (!res.ok) throw await httpError(res, label);
  const json = await res.json() as { data?: T };
  if (json.data === undefined) {
    throw new CliError(`${label}: the platform returned no data.`, {
      code: "PLATFORM_ERROR",
    });
  }
  return json.data;
}

function revisionNumber(value: string | undefined, usage: string): number {
  const number = Number(value);
  if (!value || !Number.isInteger(number) || number < 1) {
    throw new CliError(`Usage: ${usage}`, { code: "USAGE" });
  }
  return number;
}

async function readLocal(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export async function boundRevision(
  cwd: string,
  environment: string,
  instanceId: string,
): Promise<number | undefined> {
  const entry = (await readOwnLinkFile(cwd)).environments?.[environment];
  return entry?.id === instanceId ? entry.revision : undefined;
}

export async function rememberRevision(
  cwd: string,
  environment: string,
  instance: { id: string; name: string },
  revision: number,
  kind: ResourceKind = "pocketbases",
): Promise<void> {
  const link = await readOwnLinkFile(cwd);
  const entry = link.environments?.[environment];
  if (!link.projectId || entry?.id !== instance.id) return;
  await upsertEnvironment(cwd, {
    projectId: link.projectId,
    kind,
    environment,
    entry: { id: instance.id, name: entry.name ?? instance.name, revision },
  });
}

export async function rememberInstanceRevision(
  cwd: string,
  instanceId: string,
  revision: number,
): Promise<void> {
  const environments = (await readOwnLinkFile(cwd)).environments ?? {};
  for (const [environment, entry] of Object.entries(environments)) {
    if (entry.id !== instanceId) continue;
    await rememberRevision(cwd, environment, entry, revision);
  }
}

export async function currentRevision(
  client: ICloudClient,
  pocketbaseId: string,
): Promise<number | undefined> {
  const res = await client.ext("/api/pocketbases/revisions/list", {
    pocketbaseId,
    page: 1,
    perPage: 1,
  });
  if (!res.ok) {
    await res.body?.cancel();
    return undefined;
  }
  const body = await res.json().catch(() => null) as
    | { data?: { items?: { number: number }[] } }
    | null;
  const items = body?.data?.items;
  return items ? (items[0]?.number ?? 0) : undefined;
}

export function makeRevisionCommands(
  deps: CloudCmdDeps,
): Record<string, Command> {
  return Object.assign(
    {},
    ...ALL_KINDS.map((spec) => revisionCommandsFor(deps, spec)),
  );
}

const SOURCE_DETAILS =
  "Every change to the source is a numbered revision, whether it came from\n" +
  "the portal, this CLI, an AI assistant or a GitHub deploy. A revision is\n" +
  "building until its deployment finishes, then applied or failed.";

function revisionCommandsFor(
  deps: CloudCmdDeps,
  spec: KindSpec,
): Record<string, Command> {
  const { resolveOne } = makeResourceResolver(deps, spec);
  const instanceKind = spec.kind === "pocketbases";
  const noun = spec.noun;
  const target: Need = `target:${spec.kind}`;
  const nameFlag = str({
    description: `Which ${spec.idNoun}. Defaults to the directory's binding.`,
  });
  const idFlag = str({
    description: `The ${spec.idNoun}'s id, alternative to --name.`,
  });
  const envFlag = str({ description: "Which pbc.json environment to target." });
  const nameUsage = `[--name <${spec.idNoun}>]`;

  async function resolved(
    ctx: CmdCtx,
    input: Record<string, unknown>,
    args: string[],
    needs: readonly Need[] = [target],
  ) {
    const out = await resolveOne(
      ctx,
      input as { name?: string; id?: string; env?: string },
      { needs, args },
    );
    return { ...out, owner: { kind: spec.kind, id: out.found.id } as Owner };
  }

  return {
    [`${noun} revisions ls`]: defineCommand({
      path: [noun, "revisions", "ls"],
      usage: `pbc ${noun} revisions ls ${nameUsage} [--page <n>]`,
      summary: instanceKind
        ? "List the version history of an instance's files."
        : `List the version history of a ${spec.label}'s source.`,
      details: instanceKind
        ? "Every change to pb_hooks, pb_migrations and pb_public is a numbered\n" +
          "revision, whether it came from the portal, this CLI, an AI assistant,\n" +
          "a GitHub deploy, or the instance writing a migration itself."
        : SOURCE_DETAILS,
      needs: [target],
      args: [],
      flags: {
        name: nameFlag,
        id: idFlag,
        env: envFlag,
        page: str({ description: "Page of 30 revisions, newest first." }),
      },
      run: async (input, ctx) => {
        const { client, auth, owner } = await resolved(ctx, input, ctx.args);
        const page = input.page ? revisionNumber(input.page, "--page <n>") : 1;
        const data = await revisionCall<{
          items: Revision[];
          page: number;
          totalPages: number;
          liveBuild?: LiveBuild | null;
        }>(client, owner, "list", { page, perPage: 30 }, "Revision list");
        printResult(data.items, [
          { header: "#", get: (r) => String(r.number) },
          ...(instanceKind
            ? []
            : [{ header: "STATUS", get: (r: Revision) => r.status ?? "" }]),
          { header: "WHEN", get: (r) => r.created },
          { header: "FROM", get: (r) => SOURCE_LABELS[r.source] ?? r.source },
          {
            header: "BY",
            get: (r) => r.gitAuthor || authorLabel(r.author, auth.userId),
          },
          { header: "CHANGE", get: (r) => r.message ?? "" },
        ], ctx.flags.json);
        if (!ctx.flags.json && data.liveBuild) {
          console.error(liveBuildLine(data.liveBuild));
        }
        if (!ctx.flags.json && data.totalPages > data.page) {
          console.error(`Older revisions: --page ${data.page + 1}`);
        }
        return 0;
      },
    }),

    [`${noun} revisions diff`]: defineCommand({
      path: [noun, "revisions", "diff"],
      usage:
        `pbc ${noun} revisions diff <revision> [--against <revision>] ${nameUsage}`,
      summary: "Show which files a revision added, changed and removed.",
      needs: [target],
      args: [{ name: "revision", required: true }],
      flags: {
        name: nameFlag,
        id: idFlag,
        env: envFlag,
        against: str({
          description: "Compare with this revision instead of the one before.",
        }),
      },
      run: async (input, ctx) => {
        const usage = `pbc ${noun} revisions diff <revision>`;
        const number = revisionNumber(ctx.args[0], usage);
        const against = input.against === undefined
          ? undefined
          : Number(input.against);
        const { client, owner } = await resolved(
          ctx,
          input,
          ctx.args.slice(1),
        );
        const diff = await revisionCall<Diff>(client, owner, "diff", {
          number,
          against,
        }, "Revision diff");
        const rows = [
          ...diff.added.map((f) => ({
            change: "added",
            path: f.path,
            size: `${f.size}`,
          })),
          ...diff.changed.map((f) => ({
            change: "changed",
            path: f.path,
            size: `${f.previousSize} -> ${f.size}`,
          })),
          ...diff.removed.map((f) => ({
            change: "removed",
            path: f.path,
            size: `${f.previousSize}`,
          })),
        ].sort((a, b) => a.path.localeCompare(b.path));
        if (ctx.flags.json) {
          emit(true, diff, "");
          return 0;
        }
        console.log(`Revision #${diff.from} -> #${diff.to}`);
        printResult(rows, [
          { header: "CHANGE", get: (r) => r.change },
          { header: "PATH", get: (r) => r.path },
          { header: "BYTES", get: (r) => r.size },
        ], false);
        return 0;
      },
    }),

    [`${noun} revisions show`]: defineCommand({
      path: [noun, "revisions", "show"],
      usage: `pbc ${noun} revisions show <revision> <path> ${nameUsage}`,
      summary: "Print one file as it was in a revision.",
      details:
        "Text up to 1 MB prints to stdout; a larger or binary file prints a\n" +
        "download link instead.",
      needs: [target],
      args: [
        { name: "revision", required: true },
        { name: "path", required: true },
      ],
      flags: { name: nameFlag, id: idFlag, env: envFlag },
      run: async (input, ctx) => {
        const usage = `pbc ${noun} revisions show <revision> <path>`;
        const number = revisionNumber(ctx.args[0], usage);
        const path = ctx.args[1];
        if (!path || !isPullablePath(path, spec.kind)) {
          throw new CliError(
            instanceKind
              ? `Usage: ${usage} (path starts with ${
                REVISION_DIRS.join("/, ")
              }/)`
              : `Usage: ${usage} (a relative path such as src/main.ts)`,
            { code: "USAGE" },
          );
        }
        const { client, owner } = await resolved(
          ctx,
          input,
          ctx.args.slice(2),
        );
        const file = await revisionCall<{
          path: string;
          size: number;
          content?: string;
          downloadUrl?: string;
        }>(client, owner, "file", { number, path }, "Revision file");
        emit(
          ctx.flags.json,
          file,
          file.content ??
            `Binary or large file (${file.size} bytes): ${file.downloadUrl}`,
        );
        return 0;
      },
    }),

    [`${noun} revisions restore`]: defineCommand({
      path: [noun, "revisions", "restore"],
      usage: instanceKind
        ? `pbc ${noun} revisions restore <revision> [--schema] [--yes] ${nameUsage}`
        : `pbc ${noun} revisions restore <revision> [--yes] ${nameUsage}`,
      summary: instanceKind
        ? "Put hooks and public files back as they were in a revision."
        : `Put a ${spec.label}'s source back as it was in a revision.`,
      details: instanceKind
        ? "Changed hooks are rewritten and hooks added since are removed, which\n" +
          "restarts the instance; pb_public is replaced. Without --schema,\n" +
          "migrations and the database schema stay as they are. With --schema,\n" +
          "migrations added since the revision are reverted with their down\n" +
          "parts first (PocketBase 0.32.0 or later); the database is copied aside\n" +
          "before, and put back if a down part fails. The restore is itself a new\n" +
          "revision, so it can be undone the same way."
        : `The ${spec.label} is rebuilt from that source and deployed. The restore\n` +
          "is itself a new revision, so it can be undone the same way.",
      needs: [target, { explicit: true }],
      args: [{ name: "revision", required: true }],
      flags: {
        name: nameFlag,
        id: idFlag,
        env: envFlag,
        ...(instanceKind
          ? {
            schema: bool({
              description:
                "Also revert migrations added since, with their down parts.",
            }),
          }
          : {}),
      },
      run: async (input, ctx) => {
        const usage = `pbc ${noun} revisions restore <revision>`;
        const number = revisionNumber(ctx.args[0], usage);
        const { client, auth, found, owner } = await resolved(
          ctx,
          input,
          ctx.args.slice(1),
          [target, { explicit: true }],
        );
        const mode = input.schema ? "filesAndSchema" : "files";
        const preview = await revisionCall<RestorePreview>(
          client,
          owner,
          "restore-preview",
          { number, mode },
          "Restore preview",
        );
        if (preview.schemaBlocker) {
          throw new CliError(preview.schemaBlocker, { code: "CONFLICT" });
        }
        const plan = instanceKind
          ? describeRestore(preview)
          : describeSourceRestore(preview);
        if (plan.length === 0) {
          emit(
            ctx.flags.json,
            { restored: false, revision: null },
            `Files already match revision #${number}.`,
          );
          return 0;
        }
        const link = await linkedRepository(client, found.id, spec.kind);
        if (link) console.error(linkedWarning(found.name, link, spec.idNoun));
        console.error(`Restoring ${found.name} to revision #${number}:`);
        for (const line of plan) console.error(line);
        if (
          !await confirm(
            !instanceKind
              ? `The ${spec.label} is rebuilt and deployed. Continue?`
              : (preview.migrationsReverted ?? []).length > 0
              ? "The instance stops while the schema is reverted, then restarts. Continue?"
              : "The instance restarts; migrations and the schema stay as they are. Continue?",
            {
              noInput: ctx.flags.noInput || ctx.flags.json,
              yes: ctx.flags.yes,
            },
          )
        ) {
          console.error("Aborted.");
          return 0;
        }
        const data = await revisionCall<
          { revision: number | null; deploymentId?: string }
        >(
          client,
          owner,
          "restore",
          { number, mode, baseRevision: preview.current },
          "Restore",
        );
        if (data.revision !== null && data.deploymentId) {
          console.error(`Building ${found.name} (${data.deploymentId})…`);
          const outcome = await waitForDeployment(data.deploymentId, {
            baseUrl: auth.backendUrl,
            token: auth.userToken,
            fetchFn: deps.fetch,
          });
          if (outcome.status === "failed") {
            throw await deploymentFailure(
              client,
              spec.kind,
              found.id,
              outcome.statusMessage,
            );
          }
        }
        emit(
          ctx.flags.json,
          {
            restored: data.revision !== null,
            revision: data.revision,
            ...(data.deploymentId ? { deploymentId: data.deploymentId } : {}),
          },
          data.revision === null
            ? `Files already match revision #${number}.`
            : `Restored revision #${number} as revision #${data.revision}. ` +
              `Undo with: pbc ${noun} revisions restore ${data.revision - 1}`,
        );
        return 0;
      },
    }),

    [`${noun} pull`]: defineCommand({
      path: [noun, "pull"],
      usage:
        `pbc ${noun} pull [--revision <n>] [--dir <path>] [--yes] ${nameUsage}`,
      summary: instanceKind
        ? "Download an instance's hooks, migrations and public files."
        : `Download a ${spec.label}'s source.`,
      details: (instanceKind
        ? "Writes pb_hooks/, pb_migrations/ and pb_public/ as they are on the\n" +
          "instance now, or as they were in --revision, into --dir (default: this\n"
        : `Writes the ${spec.label}'s source as it is now, or as it was in\n` +
          "--revision, into --dir (default: this\n") +
        "directory). Local files that differ are overwritten after confirmation;\n" +
        "files that exist only locally are left alone" +
        (instanceKind ? "." : ", and so is a pbc.json\nalready there."),
      needs: [target],
      args: [],
      flags: {
        name: nameFlag,
        id: idFlag,
        env: envFlag,
        revision: str({
          description: "Revision to download; latest by default.",
        }),
        dir: str({ description: "Directory to write into. Default: here." }),
      },
      run: async (input, ctx) => {
        const number = input.revision === undefined
          ? undefined
          : revisionNumber(input.revision, "--revision <n>");
        const { client, found, environment, owner } = await resolved(
          ctx,
          input,
          ctx.args,
        );
        const exported = await revisionCall<{
          number: number;
          files: number;
          downloadUrl: string;
        }>(client, owner, "export", { number }, "Export");

        const res = await (deps.fetch ?? fetch)(exported.downloadUrl);
        if (!res.ok) {
          await res.body?.cancel();
          throw new CliError(`Download failed with status ${res.status}.`, {
            code: "PLATFORM_ERROR",
          });
        }
        const zip = new Uint8Array(await res.arrayBuffer());
        if (zip.length > MAX_EXPORT_BYTES) {
          throw new CliError("The download is larger than expected.", {
            code: "PLATFORM_ERROR",
          });
        }
        const files = await extractFiles(zip);
        const root = resolve(deps.cwd(), input.dir ?? ".");
        const ownLink = await localLinkFileName(root);
        if (ownLink) {
          files.delete(ownLink);
        }

        const changed: string[] = [];
        for (const [path, bytes] of files) {
          if (!isPullablePath(path, spec.kind)) {
            throw new CliError(
              `The download holds an unexpected path: ${path}`,
              {
                code: "PLATFORM_ERROR",
              },
            );
          }
          const local = await readLocal(join(root, path));
          if (local && !sameBytes(local, bytes)) {
            changed.push(path);
          }
        }
        if (
          changed.length > 0 &&
          !await confirm(
            `${changed.length} local file(s) differ and will be overwritten ` +
              `(${changed.slice(0, 3).join(", ")}${
                changed.length > 3 ? ", …" : ""
              }). Continue?`,
            {
              noInput: ctx.flags.noInput || ctx.flags.json,
              yes: ctx.flags.yes,
            },
          )
        ) {
          console.error("Aborted.");
          return 0;
        }

        for (const [path, bytes] of files) {
          const destination = join(root, path);
          await Deno.mkdir(dirname(destination), { recursive: true });
          await Deno.writeFile(destination, bytes);
        }
        if (root === resolve(deps.cwd())) {
          await rememberRevision(
            deps.cwd(),
            environment,
            found,
            exported.number,
            spec.kind,
          );
        }
        emit(
          ctx.flags.json,
          {
            revision: exported.number,
            files: files.size,
            overwritten: changed.length,
            dir: root,
          },
          `Pulled revision #${exported.number}: ${files.size} file(s) into ${root}` +
            (changed.length > 0 ? ` (${changed.length} overwritten)` : ""),
        );
        return 0;
      },
    }),
  };
}
