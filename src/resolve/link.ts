import type { ResourceKind } from "../clients/types.ts";
import { kindByAlias } from "../kinds.ts";

export function parseKind(token: string): ResourceKind | null {
  return kindByAlias(token)?.kind ?? null;
}
