import type { EnvEntry, LinkFile } from "../config.ts";
import { CliError } from "../errors.ts";
import { canPrompt, prompt, type PromptIO } from "../ui/prompt.ts";

/** The environment a first deploy records when the file names none. */
export const DEFAULT_ENVIRONMENT = "production";

export type EnvironmentChoice = {
  name: string;
  /** True when `--env` or PB_ENV named it, rather than the file. */
  explicit: boolean;
  /** True when `environments` has an entry under this name. */
  configured: boolean;
};

function assertValidName(name: string): void {
  if (name.length === 0 || /\s/.test(name)) {
    throw new CliError(
      `Invalid environment name ${JSON.stringify(name)}.`,
      2,
    );
  }
}

/**
 * Which environment a command targets: `--env` > PB_ENV > `defaultEnvironment` >
 * the sole configured entry.
 *
 * With several environments and no default the answer is genuinely unknown, so
 * this errors rather than picking one — that state only arises after `rm`
 * deleted the default, and guessing there is how you deploy to production by
 * accident. With no environments at all it answers "production", the name a
 * first deploy will record.
 */
export function resolveEnvironmentName(
  link: Partial<LinkFile> | null,
  opts: {
    flag?: string;
    env?: Record<string, string | undefined>;
  } = {},
): EnvironmentChoice {
  const environments = link?.environments ?? {};
  const names = Object.keys(environments);

  const explicit = opts.flag ?? (opts.env ?? Deno.env.toObject())["PB_ENV"];
  if (explicit) {
    assertValidName(explicit);
    return {
      name: explicit,
      explicit: true,
      configured: explicit in environments,
    };
  }

  const preferred = link?.defaultEnvironment;
  if (preferred) {
    return {
      name: preferred,
      explicit: false,
      configured: preferred in environments,
    };
  }
  if (names.length === 1) {
    return { name: names[0], explicit: false, configured: true };
  }
  if (names.length === 0) {
    return { name: DEFAULT_ENVIRONMENT, explicit: false, configured: false };
  }
  throw new CliError(
    `Multiple environments configured (${
      names.join(", ")
    }). Pass --env <name>.`,
    2,
  );
}

/**
 * Ask which environment to record, for the commands that write the first one
 * into a directory — `deploy`, `link`, `init`. Everywhere else the answer is
 * already in the file.
 *
 * Left alone: an explicit `--env`/`PB_ENV`, a file that already names an
 * environment, and anything non-interactive (`--no-input`, `--json`, no TTY),
 * which keeps "production" as the unattended default it has always been.
 */
export async function chooseEnvironment(
  choice: EnvironmentChoice,
  link: Partial<LinkFile> | null,
  opts: { noInput: boolean; io?: PromptIO },
): Promise<EnvironmentChoice> {
  const named = Object.keys(link?.environments ?? {}).length > 0 ||
    Boolean(link?.defaultEnvironment);
  if (choice.explicit || named || !canPrompt(opts)) return choice;
  const answer = await prompt(
    `Environment to deploy [${DEFAULT_ENVIRONMENT}]:`,
    opts,
  );
  const name = answer.trim();
  if (name.length === 0) return choice;
  assertValidName(name);
  return { name, explicit: false, configured: false };
}

/**
 * Reject an explicitly named environment the file does not configure. Only
 * commands that cannot create one call this — `deploy` answers the same
 * situation with "pass --name to create it" instead.
 *
 * A file with no `environments` block at all is not an error: nothing is
 * configured yet, so `--name`/`--id` still decide, exactly as before
 * environments existed. That also keeps a repo-wide `PB_ENV` in CI from
 * breaking directories that have not been linked.
 */
export function assertConfigured(
  choice: EnvironmentChoice,
  link: Partial<LinkFile> | null,
): void {
  const names = Object.keys(link?.environments ?? {});
  if (!choice.explicit || choice.configured || names.length === 0) return;
  throw new CliError(
    `Unknown environment ${JSON.stringify(choice.name)}. Configured: ${
      names.join(", ")
    }.`,
    2,
  );
}

/** The entry for `choice`, or undefined when the file binds a different kind. */
export function entryFor(
  link: Partial<LinkFile> | null,
  kind: LinkFile["kind"],
  choice: EnvironmentChoice,
): EnvEntry | undefined {
  if (!link || link.kind !== kind) return undefined;
  return link.environments?.[choice.name];
}
