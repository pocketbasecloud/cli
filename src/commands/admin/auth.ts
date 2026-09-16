import { defineCommand, str, bool, type Command } from "../../command.ts";
import type { AdminCmdDeps } from "./deps.ts";
import type { Profile } from "../../config.ts";
import { CliError } from "../../errors.ts";
import { emit } from "../../envelope.ts";
import { printResult } from "../../ui/output.ts";
import { prompt } from "../../ui/prompt.ts";
import { activeProfileName } from "../../resolve/profile.ts";

function selectProfile(
  existing: Profile | undefined,
  url: string,
): Profile {
  return existing?.url === url ? existing : { url, superuserToken: "" };
}

export function makeInstanceAuthCommands(
  deps: AdminCmdDeps,
): Record<string, Command> {
  return {
    "admin use": defineCommand({
      path: ["admin", "use"],
      usage: "pbc admin use [<url>] [--name <profile>]",
      summary:
        "Select a PocketBase instance, creating or updating its profile from a URL.",
      args: [{ name: "url", required: false }],
      flags: {
        name: str({ description: "Profile name (defaults to the URL)" }),
      },
      run: async (input, ctx) => {
        const config = await deps.loadConfig();
        const url = ctx.args[0];
        const requested = input.name;
        if (!url) {
          if (!requested) {
            throw new CliError(
              "Usage: pbc admin use [<url>] [--name <profile>]",
              { code: "USAGE" },
            );
          }
          if (!config.profiles[requested]) {
            throw new CliError(
              `No saved instance profile named "${requested}".`,
              { code: "USAGE" },
            );
          }
          config.defaultProfile = requested;
          await deps.saveConfig(config);
          emit(
            ctx.flags.json,
            { profile: requested, url: config.profiles[requested].url },
            `Using instance ${requested} (${config.profiles[requested].url}).`,
          );
          return 0;
        }
        const name = requested ?? url;
        config.profiles[name] = selectProfile(config.profiles[name], url);
        config.defaultProfile = name;
        await deps.saveConfig(config);
        emit(
          ctx.flags.json,
          { profile: name, url },
          `Using instance ${name} (${url}).`,
        );
        return 0;
      },
    }),

    "admin login": defineCommand({
      path: ["admin", "login"],
      usage:
        "pbc admin login [--url <url>] [--name <profile>] [--email <e>] [--password <p>]",
      summary:
        "Log in as the instance superuser. --url creates the profile in one step.",
      args: [],
      flags: {
        url: str({
          description: "Instance URL; its profile is created when it is new",
        }),
        name: str({
          description: "Profile name for --url (defaults to the URL)",
        }),
        email: str({ description: "Superuser email (prompts when omitted)" }),
        password: str({ description: "Superuser password (prompts when omitted)" }),
      },
      run: async (input, ctx) => {
        const config = await deps.loadConfig();
        const url = input.url;
        let name: string | null;
        if (url) {
          name = input.name ?? url;
          config.profiles[name] = selectProfile(config.profiles[name], url);
        } else {
          name = activeProfileName(config, ctx.flags.profile);
          if (!name || !config.profiles[name]) {
            throw new CliError(
              "No instance selected. Run `pbc admin use <url>` first.",
              { code: "USAGE" },
            );
          }
        }
        const profile = config.profiles[name];
        const email = input.email ??
          await prompt("Superuser email:", { noInput: ctx.flags.noInput });
        const password = input.password ??
          await prompt("Superuser password:", { noInput: ctx.flags.noInput });
        const { token } = await deps.makeClient(profile.url).authWithPassword(
          email,
          password,
        );
        profile.superuserToken = token;
        profile.email = email;
        if (url && !config.defaultProfile) config.defaultProfile = name;
        await deps.saveConfig(config);
        emit(
          ctx.flags.json,
          { ok: true, profile: name, url: profile.url },
          `Logged in to ${profile.url} (${name}).`,
        );
        return 0;
      },
    }),

    "admin logout": defineCommand({
      path: ["admin", "logout"],
      usage: "pbc admin logout [--remove]",
      summary:
        "Log out of the current instance profile. --remove also forgets it.",
      args: [],
      flags: {
        remove: bool({ description: "Also forget the profile" }),
      },
      run: async (input, ctx) => {
        const config = await deps.loadConfig();
        const name = activeProfileName(config, ctx.flags.profile);
        if (!name || !config.profiles[name]) {
          throw new CliError("No instance selected.", { code: "USAGE" });
        }
        if (input.remove) {
          delete config.profiles[name];
          if (config.defaultProfile === name) config.defaultProfile = null;
        } else {
          config.profiles[name].superuserToken = "";
        }
        await deps.saveConfig(config);
        emit(ctx.flags.json, { ok: true }, `Logged out of ${name}.`);
        return 0;
      },
    }),

    "admin whoami": defineCommand({
      path: ["admin", "whoami"],
      usage: "pbc admin whoami",
      summary: "Show the active instance profile.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const config = await deps.loadConfig();
        const name = activeProfileName(config, ctx.flags.profile);
        if (!name || !config.profiles[name]) {
          throw new CliError(
            "No instance selected. Run `pbc admin use <url>`.",
            { code: "USAGE" },
          );
        }
        const profile = config.profiles[name];
        const authed = !!profile.superuserToken;
        emit(
          ctx.flags.json,
          { profile: name, url: profile.url, authenticated: authed },
          `${name} — ${profile.url} — ${
            authed ? "authenticated" : "not logged in"
          }`,
        );
        return 0;
      },
    }),

    "admin profiles": defineCommand({
      path: ["admin", "profiles"],
      usage: "pbc admin profiles",
      summary: "List saved instance logins and which one is active.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const config = await deps.loadConfig();
        const active = activeProfileName(config, ctx.flags.profile);
        const rows = Object.entries(config.profiles)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, p]) => ({
            name,
            url: p.url,
            email: p.email ?? "",
            authenticated: !!p.superuserToken,
            active: name === active,
          }));
        printResult(rows, [
          { header: "ACTIVE", get: (r) => (r.active ? "*" : "") },
          { header: "NAME", get: (r) => r.name },
          { header: "URL", get: (r) => r.url },
          { header: "ACCOUNT", get: (r) => r.email },
          {
            header: "STATUS",
            get: (r) => (r.authenticated ? "authenticated" : ""),
          },
        ], ctx.flags.json);
        return 0;
      },
    }),
  };
}
