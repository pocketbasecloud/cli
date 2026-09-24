import { type Command, defineCommand } from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import { httpError } from "../errors.ts";
import { emit } from "../envelope.ts";

export function makeSelfDrivingCommands(
  deps: CloudCmdDeps,
): Record<string, Command> {
  async function setEnabled(on: boolean): Promise<void> {
    const { client } = await deps.requireAuth();
    const res = await client.ext("/api/account/update", {
      agentPlatformKeyAcknowledged: on,
    });
    if (!res.ok) throw await httpError(res, "Self-driving");
  }

  return {
    "self-driving status": defineCommand({
      path: ["self-driving", "status"],
      usage: "pbc self-driving status",
      summary: "Show whether self-driving pull requests are enabled.",
      details: `Self-driving reads a firing finding's evidence, works in an
isolated sandbox and opens a pull request on the connected repository. It never
merges or deploys on its own.

It is off until you enable it; \`pbc self-driving enable\` allows it on every
project of the account. Runs count toward your plan's daily and monthly
limits.`,
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client } = await deps.requireAuth();
        const user = await client.whoami();
        const enabled = user.selfDriving === true;
        const judge = user.selfDrivingJudge === true;
        emit(
          ctx.flags.json,
          { enabled, judge },
          [
            `Self-driving: ${enabled ? "allowed" : "off"}`,
            `TypeSafe judge: ${judge ? "on" : "off"}`,
          ].join("\n"),
        );
        return 0;
      },
    }),

    "self-driving enable": defineCommand({
      path: ["self-driving", "enable"],
      usage: "pbc self-driving enable",
      summary: "Allow self-driving pull requests on your account.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        await setEnabled(true);
        emit(ctx.flags.json, { enabled: true }, "Self-driving is allowed.");
        return 0;
      },
    }),

    "self-driving disable": defineCommand({
      path: ["self-driving", "disable"],
      usage: "pbc self-driving disable",
      summary: "Stop self-driving pull requests on your account.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        await setEnabled(false);
        emit(ctx.flags.json, { enabled: false }, "Self-driving is off.");
        return 0;
      },
    }),
  };
}
