import type { IAdminClient } from "../../src/clients/admin.ts";
import type {
  AdminRecord,
  BackupInfo,
  Collection,
  CronJob,
  ListRecordsOpts,
  RecordPage,
} from "../../src/clients/admin-types.ts";

export type MockAdminClient = IAdminClient & {
  calls: {
    authWithPassword: [string, string][];
    createRecord: [string, Record<string, unknown>][];
    updateRecord: [string, string, Record<string, unknown>][];
    deleteRecord: [string, string][];
    updateCollection: [string, Record<string, unknown>][];
    updateSettings: [Record<string, unknown>][];
    runCron: [string][];
    createBackup: [string][];
    deleteBackup: [string][];
  };
  collections: Collection[];
  records: Record<string, AdminRecord[]>;
  settings: Record<string, unknown>;
};

export function createMockAdminClient(
  overrides: Partial<IAdminClient> = {},
): MockAdminClient {
  const calls: MockAdminClient["calls"] = {
    authWithPassword: [],
    createRecord: [],
    updateRecord: [],
    deleteRecord: [],
    updateCollection: [],
    updateSettings: [],
    runCron: [],
    createBackup: [],
    deleteBackup: [],
  };
  const state = {
    collections: [] as Collection[],
    records: {} as Record<string, AdminRecord[]>,
    settings: { smtp: { enabled: false }, s3: { enabled: false } } as Record<
      string,
      unknown
    >,
  };
  let seq = 0;
  const id = () => `rec${++seq}`;

  const mkCollection = (name: string, type = "base"): Collection => ({
    id: id(),
    name,
    type,
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  });

  const base: IAdminClient = {
    authWithPassword: (email, password) => {
      calls.authWithPassword.push([email, password]);
      return Promise.resolve({ token: "mock-superuser-token" });
    },
    listCollections: () => Promise.resolve(state.collections),
    getCollection: (idOrName) =>
      Promise.resolve(
        state.collections.find((c) =>
          c.name === idOrName || c.id === idOrName
        ) ??
          mkCollection(idOrName),
      ),
    createCollection: (data) => {
      const c = mkCollection(
        String(data.name ?? "new"),
        String(data.type ?? "base"),
      );
      state.collections.push(c);
      return Promise.resolve(c);
    },
    updateCollection: (idOrName, data) => {
      calls.updateCollection.push([idOrName, data]);
      const c =
        state.collections.find((x) =>
          x.name === idOrName || x.id === idOrName
        ) ??
          mkCollection(idOrName);
      Object.assign(c, data);
      return Promise.resolve(c);
    },
    deleteCollection: () => Promise.resolve(),
    importCollections: () => Promise.resolve(),
    listRecords: (collection, _opts: ListRecordsOpts) => {
      const items = state.records[collection] ?? [];
      const page: RecordPage = {
        items,
        page: 1,
        perPage: 30,
        totalItems: items.length,
        totalPages: 1,
      };
      return Promise.resolve(page);
    },
    getRecord: (collection, rid) =>
      Promise.resolve(
        (state.records[collection] ?? []).find((r) => r.id === rid) ??
          { id: rid },
      ),
    createRecord: (collection, data) => {
      calls.createRecord.push([collection, data]);
      const r: AdminRecord = { id: id(), ...data };
      (state.records[collection] ??= []).push(r);
      return Promise.resolve(r);
    },
    updateRecord: (collection, rid, data) => {
      calls.updateRecord.push([collection, rid, data]);
      const r = (state.records[collection] ?? []).find((x) => x.id === rid) ??
        { id: rid };
      Object.assign(r, data);
      return Promise.resolve(r);
    },
    deleteRecord: (collection, rid) => {
      calls.deleteRecord.push([collection, rid]);
      return Promise.resolve();
    },
    getSettings: () => Promise.resolve(state.settings),
    updateSettings: (data) => {
      calls.updateSettings.push([data]);
      Object.assign(state.settings, data);
      return Promise.resolve(state.settings);
    },
    testEmail: () => Promise.resolve(),
    testS3: () => Promise.resolve(),
    listCrons: () =>
      Promise.resolve(
        [{ id: "__pbLogsCleanup__", expression: "0 */6 * * *" }] as CronJob[],
      ),
    runCron: (jobId) => {
      calls.runCron.push([jobId]);
      return Promise.resolve();
    },
    listLogs: () =>
      Promise.resolve({
        items: [],
        page: 1,
        perPage: 50,
        totalItems: 0,
        totalPages: 0,
      }),
    listBackups: () => Promise.resolve([] as BackupInfo[]),
    createBackup: (basename) => {
      calls.createBackup.push([basename]);
      return Promise.resolve();
    },
    deleteBackup: (key) => {
      calls.deleteBackup.push([key]);
      return Promise.resolve();
    },
    backupDownloadUrl: (key) =>
      Promise.resolve(`https://mock/api/backups/${key}?token=mock`),
    ...overrides,
  };

  return Object.assign(base, { calls, ...state });
}
