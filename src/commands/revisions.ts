import { dirname, join, resolve } from "@std/path";
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
import { KINDS } from "../kinds.ts";
import { CliError, httpError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import { extractFiles } from "../local/unzip.ts";
import { readOwnLinkFile, upsertEnvironment } from "../config.ts";
import { makeResourceResolver } from "./resource.ts";
import { linkedRepository, linkedWarning } from "../clients/repo-link.ts";

const REVISION_DIRS = ["pb_hooks", "pb_migrations", "pb_public"];
const MAX_EXPORT_BYTES = 200 * 1024 * 1024;

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

type Revision = {
  number: number;
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
  hooksWritten: string[];
  hooksRemoved: string[];
  publicReplaced: boolean;
  migrationsReverted: string[];
  schemaBlocker: string | null;
};

export function describeRestore(preview: RestorePreview): string[] {
  const lines: string[] = [];
  if (preview.hooksWritten.length > 0) {
    lines.push(`  write   ${preview.hooksWritten.join(", ")}`);
  }
  if (preview.hooksRemoved.length > 0) {
    lines.push(`  remove  ${preview.hooksRemoved.join(", ")}`);
  }
  if (preview.publicReplaced) lines.push("  replace pb_public");
  if (preview.migrationsReverted.length > 0) {
    lines.push(
      `  revert  ${
        preview.migrationsReverted.join(", ")
      } (down parts, newest first)`,
    );
  }
  return lines;
}

export function isPullablePath(path: string): boolean {
  const segments = path.split("/");
  return REVISION_DIRS.includes(segments[0]) && segments.length > 1 &&
    !path.includes("\\") &&
    segments.slice(1).every((s) => s !== "" && s !== "." && s !== "..");
}

export function authorLabel(author: string | undefined, me: string): string {
  if (!author) return "platform";
  return author === me ? "you" : "teammate";
}

async function revisionCall<T>(
  client: ICloudClient,
  action: string,
  body: Record<string, unknown>,
  label: string,
): Promise<T> {
  const res = await client.ext(`/api/pocketbases/revisions/${action}`, body);
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
): Promise<void> {
  const link = await readOwnLinkFile(cwd);
  const entry = link.environments?.[environment];
  if (!link.projectId || entry?.id !== instance.id) return;
  await upsertEnvironment(cwd, {
    projectId: link.projectId,
    kind: "pocketbases",
    environment,
    entry: { id: instance.id, name: entry.name ?? instance.name, revision },
  });
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
  const { resolveOne } = makeResourceResolver(deps, KINDS.pocketbases);
  const target: Need = "target:pocketbases";
  const nameFlag = str({
    description: "Which instance. Defaults to the directory's binding.",
  });
  const idFlag = str({
    description: "The instance's id, alternative to --name.",
  });
  const envFlag = str({ description: "Which pbc.json environment to target." });

  async function instance(
    ctx: CmdCtx,
    input: Record<string, unknown>,
    args: string[],
  ) {
    return await resolveOne(
      ctx,
      input as { name?: string; id?: string; env?: string },
      { needs: [target], args },
    );
  }

  return {
    "pocketbase revisions ls": defineCommand({
      path: ["pocketbase", "revisions", "ls"],
      usage: "pbc pocketbase revisions ls [--name <instance>] [--page <n>]",
      summary: "List the version history of an instance's files.",
      details:
        "Every change to pb_hooks, pb_migrations and pb_public is a numbered\n" +
        "revision, whether it came from the portal, this CLI, an AI assistant,\n" +
        "a GitHub deploy, or the instance writing a migration itself.",
      needs: [target],
      args: [],
      flags: {
        name: nameFlag,
        id: idFlag,
        env: envFlag,
        page: str({ description: "Page of 30 revisions, newest first." }),
      },
      run: async (input, ctx) => {
        const { client, auth, found } = await instance(ctx, input, ctx.args);
        const page = input.page ? revisionNumber(input.page, "--page <n>") : 1;
        const data = await revisionCall<{
          items: Revision[];
          page: number;
          totalPages: number;
        }>(client, "list", {
          pocketbaseId: found.id,
          page,
          perPage: 30,
        }, "Revision list");
        printResult(data.items, [
          { header: "#", get: (r) => String(r.number) },
          { header: "WHEN", get: (r) => r.created },
          { header: "FROM", get: (r) => SOURCE_LABELS[r.source] ?? r.source },
          {
            header: "BY",
            get: (r) => r.gitAuthor || authorLabel(r.author, auth.userId),
          },
          { header: "CHANGE", get: (r) => r.message ?? "" },
        ], ctx.flags.json);
        if (!ctx.flags.json && data.totalPages > data.page) {
          console.error(`Older revisions: --page ${data.page + 1}`);
        }
        return 0;
      },
    }),

    "pocketbase revisions diff": defineCommand({
      path: ["pocketbase", "revisions", "diff"],
      usage:
        "pbc pocketbase revisions diff <revision> [--against <revision>] [--name <instance>]",
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
        const usage = "pbc pocketbase revisions diff <revision>";
        const number = revisionNumber(ctx.args[0], usage);
        const against = input.against === undefined
          ? undefined
          : Number(input.against);
        const { client, found } = await instance(ctx, input, ctx.args.slice(1));
        const diff = await revisionCall<Diff>(client, "diff", {
          pocketbaseId: found.id,
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

    "pocketbase revisions show": defineCommand({
      path: ["pocketbase", "revisions", "show"],
      usage:
        "pbc pocketbase revisions show <revision> <path> [--name <instance>]",
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
        const usage = "pbc pocketbase revisions show <revision> <path>";
        const number = revisionNumber(ctx.args[0], usage);
        const path = ctx.args[1];
        if (!path || !isPullablePath(path)) {
          throw new CliError(
            `Usage: ${usage} (path starts with ${REVISION_DIRS.join("/, ")}/)`,
            { code: "USAGE" },
          );
        }
        const { client, found } = await instance(ctx, input, ctx.args.slice(2));
        const file = await revisionCall<{
          path: string;
          size: number;
          content?: string;
          downloadUrl?: string;
        }>(
          client,
          "file",
          { pocketbaseId: found.id, number, path },
          "Revision file",
        );
        emit(
          ctx.flags.json,
          file,
          file.content ??
            `Binary or large file (${file.size} bytes): ${file.downloadUrl}`,
        );
        return 0;
      },
    }),

    "pocketbase revisions restore": defineCommand({
      path: ["pocketbase", "revisions", "restore"],
      usage:
        "pbc pocketbase revisions restore <revision> [--schema] [--yes] [--name <instance>]",
      summary: "Put hooks and public files back as they were in a revision.",
      details:
        "Changed hooks are rewritten and hooks added since are removed, which\n" +
        "restarts the instance; pb_public is replaced. Without --schema,\n" +
        "migrations and the database schema stay as they are. With --schema,\n" +
        "migrations added since the revision are reverted with their down\n" +
        "parts first (PocketBase 0.32.0 or later); the database is copied aside\n" +
        "before, and put back if a down part fails. The restore is itself a new\n" +
        "revision, so it can be undone the same way.",
      needs: [target, { explicit: true }],
      args: [{ name: "revision", required: true }],
      flags: {
        name: nameFlag,
        id: idFlag,
        env: envFlag,
        schema: bool({
          description:
            "Also revert migrations added since, with their down parts.",
        }),
      },
      run: async (input, ctx) => {
        const usage = "pbc pocketbase revisions restore <revision>";
        const number = revisionNumber(ctx.args[0], usage);
        const { client, found } = await resolveOne(
          ctx,
          input as { name?: string; id?: string; env?: string },
          { needs: [target, { explicit: true }], args: ctx.args.slice(1) },
        );
        const mode = input.schema ? "filesAndSchema" : "files";
        const preview = await revisionCall<RestorePreview>(
          client,
          "restore-preview",
          { pocketbaseId: found.id, number, mode },
          "Restore preview",
        );
        if (preview.schemaBlocker) {
          throw new CliError(preview.schemaBlocker, { code: "CONFLICT" });
        }
        const plan = describeRestore(preview);
        if (plan.length === 0) {
          emit(
            ctx.flags.json,
            { restored: false, revision: null },
            `Files already match revision #${number}.`,
          );
          return 0;
        }
        const link = await linkedRepository(client, found.id);
        if (link) console.error(linkedWarning(found.name, link));
        console.error(`Restoring ${found.name} to revision #${number}:`);
        for (const line of plan) console.error(line);
        if (
          !await confirm(
            preview.migrationsReverted.length > 0
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
        const data = await revisionCall<{ revision: number | null }>(
          client,
          "restore",
          {
            pocketbaseId: found.id,
            number,
            mode,
            baseRevision: preview.current,
          },
          "Restore",
        );
        emit(
          ctx.flags.json,
          { restored: data.revision !== null, revision: data.revision },
          data.revision === null
            ? `Files already match revision #${number}.`
            : `Restored revision #${number} as revision #${data.revision}. ` +
              `Undo with: pbc pocketbase revisions restore ${
                data.revision - 1
              }`,
        );
        return 0;
      },
    }),

    "pocketbase pull": defineCommand({
      path: ["pocketbase", "pull"],
      usage:
        "pbc pocketbase pull [--revision <n>] [--dir <path>] [--yes] [--name <instance>]",
      summary: "Download an instance's hooks, migrations and public files.",
      details:
        "Writes pb_hooks/, pb_migrations/ and pb_public/ as they are on the\n" +
        "instance now, or as they were in --revision, into --dir (default: this\n" +
        "directory). Local files that differ are overwritten after confirmation;\n" +
        "files that exist only locally are left alone.",
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
        const { client, found, environment } = await instance(
          ctx,
          input,
          ctx.args,
        );
        const exported = await revisionCall<{
          number: number;
          files: number;
          downloadUrl: string;
        }>(client, "export", { pocketbaseId: found.id, number }, "Export");

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

        const changed: string[] = [];
        for (const [path, bytes] of files) {
          if (!isPullablePath(path)) {
            throw new CliError(
              `The download holds an unexpected path: ${path}`,
              {
                code: "PLATFORM_ERROR",
              },
            );
          }
          const local = await readLocal(join(root, path));
          if (local && !sameBytes(local, bytes)) changed.push(path);
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
