import type { Config } from "../config.ts";

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function activeProfileName(
  config: Config,
  profileFlag?: string,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string | null {
  return profileFlag ?? env["PB_PROFILE"] ?? config.defaultProfile;
}
