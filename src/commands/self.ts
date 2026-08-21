import type { CmdCtx, Handler } from "../router.ts";
import { applyUpgrade, planUpgrade, type SelfDeps } from "../self/upgrade.ts";
import { createProgress, type Progress } from "../ui/progress.ts";

/**
 * `pbc upgrade` — updates `pbc` itself. Distinct from `pbc cloud upgrade`, which
 * is about the billing plan on your account.
 */
export function makeSelfCommands(
  deps: SelfDeps,
  write: (s: string) => void = console.log,
  progress: Progress = createProgress(),
): Record<string, Handler> {
  const upgrade: Handler = async (ctx: CmdCtx) => {
    const check = ctx.raw.check === true;
    const { plan, manifest } = await progress.step(
      "Checking for a newer pbc",
      () =>
        planUpgrade(deps, {
          version: ctx.args[0],
          // --check must never install, so it also ignores --force.
          force: !check && ctx.raw.force === true,
        }),
    );

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
      write(`Installed: pbc ${plan.current} (${plan.install.kind})`);
      write(`Latest:    pbc ${plan.target}`);
      write(
        plan.updateAvailable
          ? `\nRun \`${plan.command ?? "pbc upgrade"}\` to update.`
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
        `pbc ${plan.current} is already the latest version. ` +
          "Pass --force to reinstall it.",
      );
      return 0;
    }

    if (plan.action === "manual") {
      // Exit non-zero: the requested upgrade did not happen, and a script that
      // ran `pbc upgrade` needs to know that rather than read success.
      if (ctx.flags.json) {
        write(JSON.stringify({ ...plan, upgraded: false }));
        return 1;
      }
      // For a source install `install.path` is the Deno executable, not a pbc
      // binary, so naming it would only mislead.
      const how = plan.install.kind === "npm"
        ? `This pbc was installed with npm (${plan.install.path}), so npm has to replace it:`
        : "This pbc runs from source, so update its clone instead:";
      write(
        plan.updateAvailable
          ? `pbc ${plan.current} → ${plan.target} is available.`
          : `pbc ${plan.target} requested; this is pbc ${plan.current}.`,
      );
      write(`\n${how}\n  ${plan.command}`);
      return 1;
    }

    // Fetching and verifying a ~40 MB binary, then swapping it in place.
    const res = await progress.step(
      `Downloading pbc ${plan.target}`,
      () => applyUpgrade(deps, plan, manifest),
    );
    if (ctx.flags.json) {
      write(JSON.stringify({ ...plan, upgraded: true, ...res }));
      return 0;
    }
    // "Upgraded" would be a lie for an explicitly requested rollback.
    const verb = plan.updateAvailable ? "Upgraded" : "Switched";
    write(`${verb} pbc ${plan.current} → ${plan.target} (${res.path})`);
    if (res.leftBehind) {
      write(
        `Note: the previous binary is still at ${res.leftBehind}; ` +
          "Windows keeps it locked until pbc exits. Delete it at your leisure.",
      );
    }
    return 0;
  };

  return { upgrade };
}
