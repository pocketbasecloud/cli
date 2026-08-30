import { type EnvEntry, envVar, type LinkFile } from "../config.ts";
import { CliError } from "../errors.ts";
import { canPrompt, prompt, type PromptIO } from "../ui/prompt.ts";

export const DEFAULT_ENVIRONMENT = "production";

export type EnvironmentChoice = {
  name: string;
  explicit: boolean;
  configured: boolean;
};

function assertValidName(name: string): void {
  if (name.length === 0 || /\s/.test(name)) {
    throw new CliError(
      `Invalid environment name ${JSON.stringify(name)}.`,
      { code: "INVALID_VALUE" },
    );
  }
}

export function resolveEnvironmentName(
  link: Partial<LinkFile> | null,
  opts: {
    flag?: string;
    env?: Record<string, string | undefined>;
  } = {},
): EnvironmentChoice {
  const environments = link?.environments ?? {};
  const names = Object.keys(environments);

  const explicit = opts.flag ?? envVar("ENV", opts.env);
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
    { code: "NO_TARGET", hint: "--env <name>" },
  );
}

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
    { code: "NOT_FOUND", hint: "pbc environments" },
  );
}

export function entryFor(
  link: Partial<LinkFile> | null,
  kind: LinkFile["kind"],
  choice: EnvironmentChoice,
): EnvEntry | undefined {
  if (!link || link.kind !== kind) return undefined;
  return link.environments?.[choice.name];
}
