import type { CmdCtx, Handler } from "../../router.ts";
import type { AdminCmdDeps } from "./deps.ts";
import { CliError } from "../../errors.ts";
import { prompt } from "../../ui/prompt.ts";
import { activeProfileName, hostnameOf } from "../../resolve/profile.ts";

export function makeInstanceAuthCommands(
  deps: AdminCmdDeps,
): Record<string, Handler> {
  const use: Handler = async (ctx: CmdCtx) => {
    const url = ctx.args[0] ?? (ctx.raw.url as string | undefined);
    if (!url) throw new CliError("Usage: pbc use <url> [--name <profile>]", 2);
    const name = (ctx.raw.name as string) ?? hostnameOf(url);
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
    console.log(
      ctx.flags.json
        ? JSON.stringify({ profile: name, url })
        : `Using instance ${name} (${url}).`,
    );
    return 0;
  };

  const login: Handler = async (ctx: CmdCtx) => {
    const config = await deps.loadConfig();
    const name = activeProfileName(config, ctx.flags.profile);
    if (!name || !config.profiles[name]) {
      throw new CliError("No instance selected. Run `pbc use <url>` first.", 2);
    }
    const profile = config.profiles[name];
    const email = (ctx.raw.email as string) ??
      await prompt("Superuser email:", { noInput: ctx.flags.noInput });
    const password = (ctx.raw.password as string) ??
      await prompt("Superuser password:", { noInput: ctx.flags.noInput });
    const { token } = await deps.makeClient(profile.url).authWithPassword(
      email,
      password,
    );
    profile.superuserToken = token;
    await deps.saveConfig(config);
    console.log(
      ctx.flags.json
        ? JSON.stringify({ ok: true, profile: name })
        : `Logged in to ${profile.url}.`,
    );
    return 0;
  };

  const logout: Handler = async (ctx: CmdCtx) => {
    const config = await deps.loadConfig();
    const name = activeProfileName(config, ctx.flags.profile);
    if (!name || !config.profiles[name]) {
      throw new CliError("No instance selected.", 2);
    }
    if (ctx.raw.remove === true) {
      delete config.profiles[name];
      if (config.defaultProfile === name) config.defaultProfile = null;
    } else {
      config.profiles[name].superuserToken = "";
    }
    await deps.saveConfig(config);
    console.log(
      ctx.flags.json ? JSON.stringify({ ok: true }) : `Logged out of ${name}.`,
    );
    return 0;
  };

  const whoami: Handler = async (ctx: CmdCtx) => {
    const config = await deps.loadConfig();
    const name = activeProfileName(config, ctx.flags.profile);
    if (!name || !config.profiles[name]) {
      throw new CliError("No instance selected. Run `pbc use <url>`.", 2);
    }
    const profile = config.profiles[name];
    const authed = profile.superuserToken.length > 0;
    console.log(
      ctx.flags.json
        ? JSON.stringify({
          profile: name,
          url: profile.url,
          authenticated: authed,
        })
        : `${name} — ${profile.url} — ${
          authed ? "authenticated" : "not logged in"
        }`,
    );
    return 0;
  };

  return { "use": use, "login": login, "logout": logout, "whoami": whoami };
}
