import { defineCommand, type Command } from "../command.ts";
import type { CloudAuth, Config } from "../config.ts";
import type { ICloudClient } from "../clients/cloud.ts";
import { CliError } from "../errors.ts";
import { emit } from "../envelope.ts";
import { printResult } from "../ui/output.ts";
import { confirm } from "../ui/prompt.ts";
import type { PromptIO } from "../ui/prompt.ts";
import { resolveProject } from "../resolve/project.ts";

export type CloudCmdDeps = {
  requireAuth: () => Promise<
    { client: ICloudClient; config: Config; auth: CloudAuth }
  >;
  loadConfig: () => Promise<Config>;
  saveConfig: (c: Config) => Promise<void>;
  cwd: () => string;
  io?: PromptIO;
  fetch?: typeof fetch;
  env?: (k: string) => string | undefined;
  envStatePath?: () => string;
};

export function makeProjectCommands(
  deps: CloudCmdDeps,
): Record<string, Command> {
  return {
    "project ls": defineCommand({
      path: ["project", "ls"],
      usage: "pbc project ls",
      summary: "List projects.",
      args: [],
      flags: {},
      run: async (_input, ctx) => {
        const { client, config } = await deps.requireAuth();
        const projects = await client.listProjects();
        printResult(projects, [
          { header: "ID", get: (p) => p.id },
          { header: "NAME", get: (p) => p.name },
          { header: "ORG", get: (p) => p.organization || "-" },
          {
            header: "CURRENT",
            get: (p) => (p.id === config.currentProject ? "*" : ""),
          },
        ], ctx.flags.json);
        return 0;
      },
    }),

    "project create": defineCommand({
      path: ["project", "create"],
      usage: "pbc project create <name>",
      summary: "Create a project.",
      args: [{ name: "name", required: true }],
      flags: {},
      run: async (_input, ctx) => {
        const name = ctx.args[0];
        if (!name) throw new CliError(
          "Usage: pbc project create <name>",
          { code: "USAGE" },
        );
        const { client } = await deps.requireAuth();
        const p = await client.createProject(name);
        emit(ctx.flags.json, p, `Created project ${p.name} (${p.id}).`);
        return 0;
      },
    }),

    "project use": defineCommand({
      path: ["project", "use"],
      usage: "pbc project use <name|id>",
      summary: "Set the current project.",
      args: [{ name: "name|id", required: true }],
      flags: {},
      run: async (_input, ctx) => {
        const token = ctx.args[0];
        if (!token) throw new CliError(
          "Usage: pbc project use <name|id>",
          { code: "USAGE" },
        );
        const { client } = await deps.requireAuth();
        const p = await resolveProject({
          client,
          config: await deps.loadConfig(),
          cwd: deps.cwd(),
          flagProject: token,
          noInput: true,
        });
        const config = await deps.loadConfig();
        config.currentProject = p.id;
        await deps.saveConfig(config);
        emit(ctx.flags.json, { currentProject: p.id }, `Now using ${p.name}.`);
        return 0;
      },
    }),

    "project rm": defineCommand({
      path: ["project", "rm"],
      usage: "pbc project rm <name|id> [--yes]",
      summary: "Delete a project.",
      args: [{ name: "name|id", required: true }],
      flags: {},
      run: async (_input, ctx) => {
        const token = ctx.args[0];
        if (!token) throw new CliError(
          "Usage: pbc project rm <name|id>",
          { code: "USAGE" },
        );
        const { client, config } = await deps.requireAuth();
        const p = await resolveProject({
          client,
          config,
          cwd: deps.cwd(),
          flagProject: token,
          noInput: true,
        });
        if (
          !await confirm(`Delete project ${p.name}?`, {
            noInput: ctx.flags.noInput || ctx.flags.json,
            yes: ctx.flags.yes,
          })
        ) {
          console.error("Aborted.");
          return 0;
        }
        await client.deleteProject(p.id);
        emit(ctx.flags.json, { ok: true }, `Deleted ${p.name}.`);
        return 0;
      },
    }),

  };
}
