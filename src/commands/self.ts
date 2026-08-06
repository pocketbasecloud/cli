import type { CmdCtx, Handler } from "../router.ts";
import { applyUpgrade, planUpgrade, type SelfDeps } from "../self/upgrade.ts";

/**
 * `pb upgrade` — updates `pb` itself. Distinct from `pb cloud upgrade`, which
 * is about the billing plan on your account.
 */
export function makeSelfCommands(
  deps: SelfDeps,
  write: (s: string) => void = console.log,
): Record<string, Handler> {
  const upgrade: Handler = async (ctx: CmdCtx) => {
    const check = ctx.raw.check === true;
    const { plan, manifest } = await planUpgrade(deps, {
      version: ctx.args[0],
      // --check must never install, so it also ignores --force.
      force: !check && ctx.raw.force === true,
    });

    if (check) {
      if (ctx.flags.json) {
        write(JSON.stringify({
          current: plan.current,
          latest: plan.target,
          updateAvailable: plan.updateAvailable,
          install: plan.install.kind,
          path: plan.install.path,
          command: plan.command ?? null,
        }));
        return 0;
      }
      write(`Installed: pb ${plan.current} (${plan.install.kind})`);
      write(`Latest:    pb ${plan.target}`);
      write(
        plan.updateAvailable
          ? `\nRun \`${plan.command ?? "pb upgrade"}\` to update.`
          : "\nYou are up to date.",
      );
      return 0;
    }

    if (plan.action === "up-to-date") {
      if (ctx.flags.json) {
        write(JSON.stringify({ ...plan, upgraded: false }));
        return 0;
      }
      write(
        `pb ${plan.current} is already the latest version. ` +
          "Pass --force to reinstall it.",
      );
      return 0;
    }

    if (plan.action === "manual") {
      // Exit non-zero: the requested upgrade did not happen, and a script that
      // ran `pb upgrade` needs to know that rather than read success.
      if (ctx.flags.json) {
        write(JSON.stringify({ ...plan, upgraded: false }));
        return 1;
      }
      // For a source install `install.path` is the Deno executable, not a pb
      // binary, so naming it would only mislead.
      const how = plan.install.kind === "npm"
        ? `This pb was installed with npm (${plan.install.path}), so npm has to replace it:`
        : "This pb runs from source, so update its clone instead:";
      write(
        plan.updateAvailable
          ? `pb ${plan.current} → ${plan.target} is available.`
          : `pb ${plan.target} requested; this is pb ${plan.current}.`,
      );
      write(`\n${how}\n  ${plan.command}`);
      return 1;
    }

    const res = await applyUpgrade(deps, plan, manifest);
    if (ctx.flags.json) {
      write(JSON.stringify({ ...plan, upgraded: true, ...res }));
      return 0;
    }
    // "Upgraded" would be a lie for an explicitly requested rollback.
    const verb = plan.updateAvailable ? "Upgraded" : "Switched";
    write(`${verb} pb ${plan.current} → ${plan.target} (${res.path})`);
    if (res.leftBehind) {
      write(
        `Note: the previous binary is still at ${res.leftBehind}; ` +
          "Windows keeps it locked until pb exits. Delete it at your leisure.",
      );
    }
    return 0;
  };

  return { upgrade };
}
