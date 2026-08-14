import PocketBase, { ClientResponseError } from "pocketbase";
import { CliError, fieldErrors } from "../errors.ts";
import type {
  AdminRecord,
  BackupInfo,
  Collection,
  CronJob,
  ListRecordsOpts,
  RecordPage,
} from "./admin-types.ts";

export interface IAdminClient {
  authWithPassword(email: string, password: string): Promise<{ token: string }>;
  listCollections(): Promise<Collection[]>;
  getCollection(idOrName: string): Promise<Collection>;
  createCollection(data: Record<string, unknown>): Promise<Collection>;
  updateCollection(
    idOrName: string,
    data: Record<string, unknown>,
  ): Promise<Collection>;
  deleteCollection(idOrName: string): Promise<void>;
  importCollections(
    collections: Record<string, unknown>[],
    deleteMissing: boolean,
  ): Promise<void>;
  listRecords(collection: string, opts: ListRecordsOpts): Promise<RecordPage>;
  getRecord(collection: string, id: string): Promise<AdminRecord>;
  createRecord(
    collection: string,
    data: Record<string, unknown>,
  ): Promise<AdminRecord>;
  updateRecord(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<AdminRecord>;
  deleteRecord(collection: string, id: string): Promise<void>;
  getSettings(): Promise<Record<string, unknown>>;
  updateSettings(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  testEmail(toEmail: string): Promise<void>;
  testS3(): Promise<void>;
  listCrons(): Promise<CronJob[]>;
  runCron(jobId: string): Promise<void>;
  listLogs(
    opts: { filter?: string; page?: number; perPage?: number },
  ): Promise<RecordPage>;
  listBackups(): Promise<BackupInfo[]>;
  createBackup(basename: string): Promise<void>;
  deleteBackup(key: string): Promise<void>;
  backupDownloadUrl(key: string): Promise<string>;
}

export function mapAdminError(e: unknown): CliError {
  if (e instanceof ClientResponseError) {
    if (e.status === 401 || e.status === 403) {
      return new CliError(
        "Not authenticated to this instance. Run `pb login`.",
        4,
      );
    }
    const msg = e.response?.message ?? e.message;
    // "Failed to create collection." alone never says what was wrong with it;
    // the reason is one entry per rejected field in `data`.
    const { detail, fields } = fieldErrors(e.response?.data);
    return new CliError(
      `Instance error (${e.status}): ${msg}${detail ? ` — ${detail}` : ""}`,
      1,
      fields,
    );
  }
  return new CliError(String(e), 1);
}

function generateTraceId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export class PocketBaseAdminClient implements IAdminClient {
  private pb: PocketBase;
  constructor(url: string, token?: string) {
    this.pb = new PocketBase(url);
    if (token) this.pb.authStore.save(token, null);

    // Inject trace headers for cross-service correlation.
    this.pb.beforeSend = (url, options) => {
      options.headers = Object.assign(options.headers || {}, {
        "X-Trace-Id": generateTraceId(),
        "X-Client-Type": "cli",
      });
      return { url, options };
    };
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw mapAdminError(e);
    }
  }

  authWithPassword(
    email: string,
    password: string,
  ): Promise<{ token: string }> {
    return this.guard(async () => {
      await this.pb.collection("_superusers").authWithPassword(email, password);
      return { token: this.pb.authStore.token };
    });
  }

  listCollections(): Promise<Collection[]> {
    return this.guard(async () =>
      await this.pb.collections.getFullList() as unknown as Collection[]
    );
  }

  getCollection(idOrName: string): Promise<Collection> {
    return this.guard(async () =>
      await this.pb.collections.getOne(idOrName) as unknown as Collection
    );
  }

  createCollection(data: Record<string, unknown>): Promise<Collection> {
    return this.guard(async () =>
      await this.pb.collections.create(data) as unknown as Collection
    );
  }

  updateCollection(
    idOrName: string,
    data: Record<string, unknown>,
  ): Promise<Collection> {
    return this.guard(async () =>
      await this.pb.collections.update(idOrName, data) as unknown as Collection
    );
  }

  deleteCollection(idOrName: string): Promise<void> {
    return this.guard(async () => {
      await this.pb.collections.delete(idOrName);
    });
  }

  importCollections(
    collections: Record<string, unknown>[],
    deleteMissing: boolean,
  ): Promise<void> {
    return this.guard(async () => {
      // deno-lint-ignore no-explicit-any
      await this.pb.collections.import(collections as any, deleteMissing);
    });
  }

  listRecords(collection: string, opts: ListRecordsOpts): Promise<RecordPage> {
    return this.guard(async () => {
      const res = await this.pb.collection(collection).getList(
        opts.page ?? 1,
        opts.perPage ?? 30,
        { filter: opts.filter ?? "", sort: opts.sort ?? "" },
      );
      return res as unknown as RecordPage;
    });
  }

  getRecord(collection: string, id: string): Promise<AdminRecord> {
    return this.guard(async () =>
      await this.pb.collection(collection).getOne(id) as unknown as AdminRecord
    );
  }

  createRecord(
    collection: string,
    data: Record<string, unknown>,
  ): Promise<AdminRecord> {
    return this.guard(async () =>
      await this.pb.collection(collection).create(
        data,
      ) as unknown as AdminRecord
    );
  }

  updateRecord(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<AdminRecord> {
    return this.guard(async () =>
      await this.pb.collection(collection).update(
        id,
        data,
      ) as unknown as AdminRecord
    );
  }

  deleteRecord(collection: string, id: string): Promise<void> {
    return this.guard(async () => {
      await this.pb.collection(collection).delete(id);
    });
  }

  getSettings(): Promise<Record<string, unknown>> {
    return this.guard(async () =>
      await this.pb.settings.getAll() as unknown as Record<string, unknown>
    );
  }

  updateSettings(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.guard(async () =>
      await this.pb.settings.update(data) as unknown as Record<string, unknown>
    );
  }

  testEmail(toEmail: string): Promise<void> {
    return this.guard(async () => {
      await this.pb.settings.testEmail("_superusers", toEmail, "verification");
    });
  }

  testS3(): Promise<void> {
    return this.guard(async () => {
      await this.pb.settings.testS3("storage");
    });
  }

  listCrons(): Promise<CronJob[]> {
    return this.guard(async () =>
      await this.pb.crons.getFullList() as CronJob[]
    );
  }

  runCron(jobId: string): Promise<void> {
    return this.guard(async () => {
      await this.pb.crons.run(jobId);
    });
  }

  listLogs(
    opts: { filter?: string; page?: number; perPage?: number },
  ): Promise<RecordPage> {
    return this.guard(async () => {
      const res = await this.pb.logs.getList(
        opts.page ?? 1,
        opts.perPage ?? 50,
        {
          filter: opts.filter ?? "",
        },
      );
      return res as unknown as RecordPage;
    });
  }

  listBackups(): Promise<BackupInfo[]> {
    return this.guard(async () =>
      await this.pb.backups.getFullList() as BackupInfo[]
    );
  }

  createBackup(basename: string): Promise<void> {
    return this.guard(async () => {
      await this.pb.backups.create(basename);
    });
  }

  deleteBackup(key: string): Promise<void> {
    return this.guard(async () => {
      await this.pb.backups.delete(key);
    });
  }

  backupDownloadUrl(key: string): Promise<string> {
    return this.guard(async () => {
      const token = await this.pb.files.getToken();
      return this.pb.backups.getDownloadURL(token, key);
    });
  }
}
