import { CliError, httpError } from "../errors.ts";
import { type HashableFile, HashIndex } from "../hash-index.ts";
import type { ICloudClient } from "./cloud.ts";
import type { DeployCommit } from "../git-commit.ts";

const PUT_CONCURRENCY = 8;
const HASH_CONCURRENCY = 64;
const UNSUPPORTED_STATUSES = [404, 503];

export type FileEntry = HashableFile;

type HashedFile = { path: string; hash: string; size: number };

export type CommitFilesInput = {
  pocketbaseId: string;
  entries: FileEntry[];
  index?: HashIndex;
  replace: string[];
  baseRevision?: number;
  dryRun?: boolean;
  git?: DeployCommit;
  onProgress?: (done: number, total: number) => void;
  onUndo?: (revision: number) => Promise<void>;
};

export async function recordedRevisionOf(
  res: Response,
): Promise<number | undefined> {
  const body = await res.clone().json().catch(() => null) as
    | { revision?: unknown; data?: { revision?: unknown } }
    | null;
  const revision = body?.revision ?? body?.data?.revision;
  return typeof revision === "number" ? revision : undefined;
}

export type CommitFilesResult =
  | { status: "unsupported" }
  | { status: "planned"; upload: number; uploadBytes: number; total: number }
  | {
    status: "committed";
    revision: number | null;
    upload: number;
    uploadBytes: number;
    total: number;
  };

async function hashEntries(
  entries: FileEntry[],
  index: HashIndex,
): Promise<HashedFile[]> {
  const hashed: HashedFile[] = [];
  for (let i = 0; i < entries.length; i += HASH_CONCURRENCY) {
    hashed.push(
      ...await Promise.all(
        entries.slice(i, i + HASH_CONCURRENCY).map(async (entry) => ({
          path: entry.name,
          hash: await index.hashOf(entry),
          size: entry.size,
        })),
      ),
    );
  }
  return hashed;
}

async function dataOf<T>(res: Response, label: string): Promise<T> {
  const body = await res.json().catch(() => null) as { data?: T } | null;
  if (body?.data === undefined) {
    throw new CliError(`${label}: the platform returned no data.`, {
      code: "PLATFORM_ERROR",
    });
  }
  return body.data;
}

async function conflictError(res: Response): Promise<CliError | null> {
  if (res.status !== 409) return null;
  const body = await res.clone().json().catch(() => null) as
    | { code?: string; message?: string }
    | null;
  if (body?.code !== "revisionConflict") return null;
  await res.body?.cancel();
  return new CliError(
    `${body.message} Nothing was installed. Run pbc pocketbase pull to get the current files, or deploy with --force to replace them.`,
    { code: "CONFLICT" },
  );
}

export async function commitFiles(
  client: ICloudClient,
  input: CommitFilesInput,
  fetchFn: typeof fetch = fetch,
): Promise<CommitFilesResult> {
  const index = input.index ?? HashIndex.memory();
  const files = await hashEntries(input.entries, index);
  const begin = await client.ext("/api/pocketbases/revisions/upload", {
    pocketbaseId: input.pocketbaseId,
    files,
  });
  if (UNSUPPORTED_STATUSES.includes(begin.status)) {
    await begin.body?.cancel();
    return { status: "unsupported" };
  }
  if (!begin.ok) throw await httpError(begin, "Upload");
  const { uploads } = await dataOf<
    { uploads: { hash: string; url: string }[] }
  >(begin, "Upload");

  const sources = new Map(
    input.entries.map((entry, i) => [files[i].hash, entry]),
  );
  const uploadBytes = uploads.reduce(
    (sum, u) => sum + (sources.get(u.hash)?.size ?? 0),
    0,
  );
  const counts = {
    upload: uploads.length,
    uploadBytes,
    total: files.length,
  };
  await index.save();
  if (input.dryRun) return { status: "planned", ...counts };

  let done = 0;
  input.onProgress?.(done, uploads.length);
  for (let i = 0; i < uploads.length; i += PUT_CONCURRENCY) {
    await Promise.all(
      uploads.slice(i, i + PUT_CONCURRENCY).map(async ({ hash, url }) => {
        const res = await fetchFn(url, {
          method: "PUT",
          body: new Blob([new Uint8Array(await sources.get(hash)!.read())]),
        });
        await res.body?.cancel();
        if (!res.ok) {
          throw new CliError(`Upload failed with status ${res.status}`);
        }
        input.onProgress?.(++done, uploads.length);
      }),
    );
  }

  const commit = await client.ext("/api/pocketbases/revisions/commit", {
    pocketbaseId: input.pocketbaseId,
    files,
    replace: input.replace,
    ...(input.baseRevision !== undefined
      ? { baseRevision: input.baseRevision }
      : {}),
    ...(input.git ? { git: input.git } : {}),
  });
  const conflict = await conflictError(commit);
  if (conflict) throw conflict;
  if (!commit.ok) {
    const recorded = await recordedRevisionOf(commit);
    if (recorded !== undefined) await input.onUndo?.(recorded);
    throw await httpError(commit, "Deploy");
  }
  const { revision } = await dataOf<{ revision: number | null }>(
    commit,
    "Deploy",
  );
  return { status: "committed", revision, ...counts };
}
