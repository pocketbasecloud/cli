export type Collection = {
  id: string;
  name: string;
  type: string;
  system?: boolean;
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
  [k: string]: unknown;
};

export type AdminRecord = { id: string; [k: string]: unknown };
export type CronJob = { id: string; expression: string };
export type BackupInfo = { key: string; size: number; modified: string };

export type RecordPage = {
  items: AdminRecord[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
};

export type ListRecordsOpts = {
  filter?: string;
  sort?: string;
  page?: number;
  perPage?: number;
};
