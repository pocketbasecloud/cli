import {
  bool,
  type CmdCtx,
  type Command,
  defineCommand,
  type Need,
  str,
} from "../command.ts";
import type { CloudCmdDeps } from "./project.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import type { Resource } from "../clients/types.ts";
import { CliError, httpError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { canPrompt, confirm, select } from "../ui/prompt.ts";
import { computeLabel, locationCity } from "../ui/compute.ts";
import { createProgress } from "../ui/progress.ts";
import { makeResourceResolver } from "./resource.ts";
import { isMoving, KINDS, MOVE_FAILED_SUB_STATUS } from "../kinds.ts";

export type MoveTarget = {
  serverId: string;
  kind: "pool" | "compute";
  location?: string;
  newAddress: string;
  ip?: string;
};

export type MovePlan = "free" | "starter" | "pro";

export type MoveOptions = {
  needsMove: boolean;
  plan: MovePlan;
  fromFreeCluster: boolean;
  blockedReason?: string;
  targets: MoveTarget[];
};

export type MoveWait = { intervalMs: number; timeoutMs: number };

const DEFAULT_WAIT: MoveWait = { intervalMs: 3_000, timeoutMs: 30 * 60_000 };
const MOVE_FAILED_FALLBACK =
  "The move did not complete. Your instance is running where it was, with nothing changed.";

export function moveTargetLabel(target: MoveTarget, index: number): string {
  if (target.kind === "compute") return computeLabel(index, target.location);
  return target.location
    ? `Starter cluster — ${locationCity(target.location)}`
    : "Starter cluster";
}

const PLAN_DESTINATION: Record<MovePlan, string> = {
  free: "the Free cluster",
  starter: "the Starter cluster",
  pro: "your private compute",
};

export function moveDestination(options: MoveOptions): string {
  return options.needsMove ? PLAN_DESTINATION[options.plan] : "another compute";
}

export function moveSummary(
  resource: Resource,
  target: MoveTarget,
  label: string,
): string[] {
  const lines = [
    `  Destination  ${label}`,
    `  New address  ${target.newAddress}`,
  ];
  if (resource.domain) {
    lines.push(
      `  Old address  ${resource.domain} (keeps working and forwards to the new address)`,
    );
  }
  lines.push(
    "  Offline      while its data is copied: usually under a minute, longer for a large database",
    "  What moves   records, files, users, superusers, hooks, environment variables, migrations, public files",
  );
  if (resource.custom_domain) {
    const apex = resource.custom_domain.split(".").length <= 2;
    const cname = `${resource.id}.pocketbasecloud.com`;
    const pointAt = apex
      ? target.ip ? `an A record at ${target.ip}` : undefined
      : `a CNAME at ${cname}${
        target.ip ? ` (or an A record at ${target.ip})` : ""
      }`;
    lines.push(
      `  Custom domain ${resource.custom_domain} keeps working through the forward` +
        (pointAt ? `; point ${pointAt} when convenient` : ""),
    );
  }
  return lines;
}

async function fetchMoveOptions(
  client: ICloudClient,
  pocketbaseId: string,
): Promise<MoveOptions> {
  const res = await client.ext("/api/pocketbases/move-options", undefined, {
    method: "GET",
    query: { pocketbaseId },
  });
  if (!res.ok) throw await httpError(res, "Move options");
  const body = await res.json().catch(() => ({})) as { data?: MoveOptions };
  if (!body.data) throw new CliError("Move options could not be read.");
  return body.data;
}

async function chooseTarget(
  ctx: CmdCtx,
  targets: MoveTarget[],
  to: string | undefined,
  io: CloudCmdDeps["io"],
): Promise<{ target: MoveTarget; index: number }> {
  if (to) {
    const index = targets.findIndex((t) => t.serverId === to);
    if (index < 0) {
      throw new CliError(
        `${to} is not a compute this instance can move to. Choose one of: ` +
          targets.map((t, i) => `${t.serverId} (${moveTargetLabel(t, i)})`)
            .join(", "),
        { code: "INVALID_VALUE" },
      );
    }
    return { target: targets[index], index };
  }
  if (targets.length === 1) return { target: targets[0], index: 0 };
  const opts = { noInput: ctx.flags.noInput || ctx.flags.json, io };
  if (!canPrompt(opts)) {
    throw new CliError(
      "This instance can move to more than one compute. Pass --to with one of: " +
        targets.map((t, i) => `${t.serverId} (${moveTargetLabel(t, i)})`)
          .join(", "),
      { code: "USAGE" },
    );
  }
  const target = await select(
    "Move to which compute?",
    targets,
    (t, i) => `${moveTargetLabel(t, i)}  ${t.newAddress}`,
    opts,
  );
  return { target, index: targets.indexOf(target) };
}

async function waitForMove(
  client: ICloudClient,
  id: string,
  wait: MoveWait,
): Promise<Resource> {
  const deadline = Date.now() + wait.timeoutMs;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, wait.intervalMs));
    const current = await client.getResource("pocketbases", id);
    if (!isMoving(current)) return current;
    if (Date.now() > deadline) {
      throw new CliError(
        `The move is still running after ${
          Math.round(wait.timeoutMs / 60_000)
        } minutes.`,
        {
          code: "TIMEOUT",
          hint: "Check `pbc pocketbase info` for its current status.",
        },
      );
    }
  }
}

export function makePbMoveCommands(
  deps: CloudCmdDeps,
  wait: MoveWait = DEFAULT_WAIT,
): Record<string, Command> {
  const { resolveOne } = makeResourceResolver(deps, KINDS.pocketbases);
  const needs: readonly Need[] = ["target:pocketbases", { explicit: true }];
  const positional = {
    name: "name",
    required: false,
    description: "Positional name, alternative to --name/--id",
  };
  const targetFlags = {
    name: str({ description: "Which instance. Asked for when omitted." }),
    id: str({ description: "The instance's id, alternative to --name." }),
    env: str({ description: "Which pbc.json environment to target." }),
  };

  return {
    "pocketbase move": defineCommand({
      path: ["pocketbase", "move"],
      usage: "pbc pocketbase move (<name>|--name <name>|--id <id>) " +
        "[--to <compute id>] [--no-wait] [--yes] [--env <name>]",
      summary: "Move an instance to another compute.",
      details:
        `After a plan upgrade an instance keeps running where it was created;
moving it takes it to the compute the plan includes. On Pro, an instance can
also move between your computes, for example to keep busy instances apart
from quiet ones. Moving copies its data, users, hooks and settings. It is
offline while the data is copied: usually under a minute, longer for a large
database.

Its old address keeps working and forwards to the new one, so apps can be
updated when convenient. The stopped previous copy stays until you delete it
with \`pbc pocketbase previous-copy rm\`.`,
      needs,
      args: [positional],
      flags: {
        ...targetFlags,
        to: str({
          description: "Compute id to move to, when more than one is offered.",
        }),
        noWait: bool({
          description: "Start the move and return without waiting for it.",
        }),
      },
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input, { needs });
        const options = await fetchMoveOptions(client, found.id);
        if (options.blockedReason) {
          throw new CliError(options.blockedReason, { code: "CONFLICT" });
        }
        if (options.targets.length === 0) {
          throw new CliError(
            "There is no room to move this instance right now.",
            { code: "CONFLICT", hint: "Try again later.", retryable: true },
          );
        }

        const { target, index } = await chooseTarget(
          ctx,
          options.targets,
          input.to,
          deps.io,
        );
        console.error(
          [
            `Move ${found.name} to ${moveDestination(options)}:`,
            ...moveSummary(found, target, moveTargetLabel(target, index)),
          ].join("\n"),
        );
        if (
          !await confirm(
            `Move ${found.name} now? It is offline while its data is copied.`,
            {
              noInput: ctx.flags.noInput || ctx.flags.json,
              yes: ctx.flags.yes,
              io: deps.io,
            },
          )
        ) {
          console.error("Aborted.");
          return 0;
        }

        const res = await client.ext("/api/pocketbases/move", {
          pocketbaseId: found.id,
          serverId: target.serverId,
        });
        if (!res.ok) throw await httpError(res, "Move");

        if (input.noWait) {
          emit(
            ctx.flags.json,
            {
              id: found.id,
              status: "moving",
              serverId: target.serverId,
              newAddress: target.newAddress,
            },
            `Move started. Follow it with \`pbc pocketbase info ${found.name}\`.`,
          );
          return 0;
        }

        const progress = createProgress({ silent: ctx.flags.json });
        const moved = await progress.step(
          `Moving ${found.name} — copying its data`,
          async (step) => {
            const result = await waitForMove(client, found.id, wait);
            if (result.subStatus === MOVE_FAILED_SUB_STATUS) {
              step.fail("The move did not complete.");
              throw new CliError(
                result.statusMessage || MOVE_FAILED_FALLBACK,
                { code: "PLATFORM_ERROR", retryable: true },
              );
            }
            step.done(`Moved ${found.name}.`);
            return result;
          },
        );
        emit(
          ctx.flags.json,
          {
            id: moved.id,
            moved: true,
            domain: moved.domain ?? null,
            previousDomain: moved.previousDomain ?? null,
            movedAt: moved.movedAt ?? null,
          },
          [
            `It now runs at ${moved.domain ?? target.newAddress}.`,
            ...(moved.previousDomain
              ? [
                `${moved.previousDomain} forwards here until you delete the previous copy:`,
                `  pbc pocketbase previous-copy rm ${found.name}`,
              ]
              : []),
          ].join("\n"),
        );
        return 0;
      },
    }),

    "pocketbase previous-copy rm": defineCommand({
      path: ["pocketbase", "previous-copy", "rm"],
      usage:
        "pbc pocketbase previous-copy rm (<name>|--name <name>|--id <id>) " +
        "[--yes] [--env <name>]",
      summary: "Delete the copy a move left behind and stop its old address.",
      details:
        `A moved instance keeps its stopped previous copy, and the old address
forwards to the new one while that copy exists. Deleting it stops the
forwarding: apps and links that still use the old address will fail.`,
      needs,
      args: [positional],
      flags: targetFlags,
      run: async (input, ctx) => {
        const { client, found } = await resolveOne(ctx, input, { needs });
        if (!found.previousDomain) {
          throw new CliError(`${found.name} has no previous copy.`, {
            code: "NOT_FOUND",
            hint: "Only a moved instance has one.",
          });
        }
        if (
          !await confirm(
            `Delete the previous copy of ${found.name}? ` +
              `${found.previousDomain} stops forwarding.`,
            {
              noInput: ctx.flags.noInput || ctx.flags.json,
              yes: ctx.flags.yes,
              io: deps.io,
            },
          )
        ) {
          console.error("Aborted.");
          return 0;
        }
        const res = await client.ext("/api/pocketbases/previous-copy/delete", {
          pocketbaseId: found.id,
        });
        if (!res.ok) throw await httpError(res, "Delete previous copy");
        emit(
          ctx.flags.json,
          { id: found.id, previousDomain: found.previousDomain, deleted: true },
          `Deleted the previous copy. ${found.previousDomain} no longer forwards.`,
        );
        return 0;
      },
    }),
  };
}
