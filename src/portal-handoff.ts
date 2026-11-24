import { CliError } from "./errors.ts";

const HTTP_FORBIDDEN = 403;
const SESSION_ONLY = "session";

export async function portalHandoff(
  res: Response,
  url: string,
  open: (url: string) => void,
): Promise<CliError | null> {
  if (res.status !== HTTP_FORBIDDEN) return null;
  const body = await res.clone().json().catch(() => null) as
    | { error?: string }
    | null;
  if (body?.error !== SESSION_ONLY) return null;
  let opened = true;
  try {
    open(url);
  } catch {
    opened = false;
  }
  return new CliError(
    `This change is made in the portal, signed in as yourself: ${url}` +
      (opened ? " (opened in your browser)." : "."),
    { code: "FORBIDDEN" },
  );
}
