import { defineCommand, str, bool, type Command } from "../../command.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";
import { emit } from "../../envelope.ts";
import { prompt } from "../../ui/prompt.ts";
import { activeProfileName, hostnameOf } from "../../resolve/profile.ts";

export function makeInstanceAuthCommands(
  deps: AdminCmdDeps,
): Record<string, Command> {
  return {
    "admin use": defineCommand({
      path: ["admin", "use"],
      usage: "pbc admin use <url> [--name <profile>]",
      summary: "Select a PocketBase instance.",
      args: [{ name: "url", required: true }],
      flags: {
        name: str({ description: "Profile name (defaults to the host)" }),
      },
      run: async (input, ctx) => {
        const url = ctx.args[0];
        if (!url) throw new CliError(
          "Usage: pbc admin use <url> [--name <profile>]",
          { code: "USAGE" },
        );
        const name = input.name ?? hostnameOf(url);
        const config = await deps.loadConfig();
        const existing = config.profiles[name];
        config.profiles[name] = {
          url,
          superuserToken: existing && existing.url === url
            ? existing.superuserToken
            : "",
        };
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
      usage: "pbc admin login [--email <e>] [--password <p>]",
      summary: "Log in as the instance superuser.",
      args: [],
      flags: {
        email: str({ description: "Superuser email (prompts when omitted)" }),
        password: str({ description: "Superuser password (prompts when omitted)" }),
      },
      run: async (input, ctx) => {
        const config = await deps.loadConfig();
        const name = activeProfileName(config, ctx.flags.profile);
        if (!name || !config.profiles[name]) {
          throw new CliError(
            "No instance selected. Run `pbc admin use <url>` first.",
            { code: "USAGE" },
          );
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
        await deps.saveConfig(config);
        emit(
          ctx.flags.json,
          { ok: true, profile: name },
          `Logged in to ${profile.url}.`,
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
  };
}
