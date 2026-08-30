import {
  bool,
  type Command,
  defineCommand,
} from "../command.ts";
import { applyUpgrade, planUpgrade, type SelfDeps } from "../self/upgrade.ts";
import { createProgress, type Progress } from "../ui/progress.ts";
import { emit } from "../envelope.ts";

export function makeSelfCommands(
  deps: SelfDeps,
  write: (s: string) => void = console.log,
  progress: Progress = createProgress(),
): Record<string, Command> {
  return {
    "self upgrade": defineCommand({
      path: ["self", "upgrade"],
      usage: "pbc self upgrade [<version>] [--check] [--force] [--json]",
      summary: "Update pbc itself to the latest release.",
      details: `Downloads the release archive for this OS and CPU, verifies its
SHA-256 against the release's checksums.txt, and replaces the running
binary. Nothing is changed unless the checksum matches.

Pass a <version> to install a specific release, including an older one
to roll back. --check reports what is available without installing;
--force reinstalls the version you already have.

Only a standalone binary (the \`curl | sh\` installer, or a release
archive) can be replaced in place. An npm install must be updated with
npm, and a from-source install by updating its clone; in both cases
\`pbc self upgrade\` prints the exact command and exits non-zero.

pbc also looks for a newer release once a day on its own and mentions
one on stderr after a command finishes. Set PBC_NO_UPDATE_CHECK to turn
that off; it is already skipped under --json, CI, and redirected
output.

To change your plan, see \`pbc plan\` instead.`,
      args: [{
        name: "version",
        required: false,
        description: "Release to install, e.g. 0.2.4. Defaults to the latest.",
      }],
      flags: {
        check: bool({
          description: "Report the available version without installing it",
        }),
        force: bool({
          description: "Reinstall even when already on the target version",
        }),
      },
      run: async (input, ctx) => {
        const check = input.check === true;
        const { plan, manifest } = await progress.step(
          "Checking for a newer pbc",
          () =>
            planUpgrade(deps, {
              version: ctx.args[0],
              force: !check && input.force === true,
            }),
        );

        if (check) {
          emit(
            ctx.flags.json,
            {
              current: plan.current,
              latest: plan.target,
              updateAvailable: plan.updateAvailable,
              install: plan.install.kind,
              path: plan.install.path,
              command: plan.command ?? null,
            },
            () =>
              [
                `Installed: pbc ${plan.current} (${plan.install.kind})`,
                `Latest:    pbc ${plan.target}`,
                plan.updateAvailable
                  ? `\nRun \`${plan.command ?? "pbc self upgrade"}\` to update.`
                  : "\nYou are up to date.",
              ].join("\n"),
            write,
          );
          return 0;
        }

        if (plan.action === "up-to-date") {
          emit(
            ctx.flags.json,
            { ...plan, upgraded: false },
            `pbc ${plan.current} is already the latest version. ` +
              "Pass --force to reinstall it.",
            write,
          );
          return 0;
        }

        if (plan.action === "manual") {
          const how = plan.install.kind === "npm"
            ? `This pbc was installed with npm (${plan.install.path}), so npm has to replace it:`
            : "This pbc runs from source, so update its clone instead:";
          emit(
            ctx.flags.json,
            { ...plan, upgraded: false },
            [
              plan.updateAvailable
                ? `pbc ${plan.current} → ${plan.target} is available.`
                : `pbc ${plan.target} requested; this is pbc ${plan.current}.`,
              `\n${how}\n  ${plan.command}`,
            ].join("\n"),
            write,
          );
          return 1;
        }

        const res = await progress.step(
          `Downloading pbc ${plan.target}`,
          () => applyUpgrade(deps, plan, manifest),
        );
        const verb = plan.updateAvailable ? "Upgraded" : "Switched";
        emit(
          ctx.flags.json,
          { ...plan, upgraded: true, ...res },
          () =>
            [
              `${verb} pbc ${plan.current} → ${plan.target} (${res.path})`,
              ...(res.leftBehind
                ? [
                  `Note: the previous binary is still at ${res.leftBehind}; ` +
                  "Windows keeps it locked until pbc exits. Delete it at your leisure.",
                ]
                : []),
            ].join("\n"),
          write,
        );
        return 0;
      },
    }),
  };
}
