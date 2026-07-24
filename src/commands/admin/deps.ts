import type { Config, Profile } from "../../config.ts";
import type { IAdminClient } from "../../clients/admin.ts";

export type AdminCmdDeps = {
  requireAdmin: () => Promise<
    { client: IAdminClient; profile: Profile; name: string }
  >;
  loadConfig: () => Promise<Config>;
  saveConfig: (c: Config) => Promise<void>;
  makeClient: (url: string, token?: string) => IAdminClient;
};
