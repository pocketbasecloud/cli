// Per-command spec, used to render `pbc <command> --help` (human) and
// `pbc <command> --help --json` / `pbc --help --json` (machine-readable).
// Keys must match the command paths registered in src/commands/index.ts.

export type ArgSpec = { name: string; required: boolean; description?: string };
export type FlagSpec = {
  name: string;
  type: "string" | "boolean";
  required: boolean;
  choices?: string[];
  description?: string;
};
export type CommandSpec = {
  usage: string;
  summary: string;
  details?: string;
  args: ArgSpec[];
  flags: FlagSpec[];
};

export const COMMANDS: Record<string, CommandSpec> = {
  // Cloud account
  "cloud login": {
    usage: "pbc cloud login",
    summary: "Log in to PocketBase Cloud via browser.",
    args: [],
    flags: [],
  },
  "cloud logout": {
    usage: "pbc cloud logout",
    summary: "Log out of PocketBase Cloud.",
    args: [],
    flags: [],
  },
  "cloud whoami": {
    usage: "pbc cloud whoami",
    summary: "Show the logged-in PocketBase Cloud account.",
    args: [],
    flags: [],
  },

  // Projects
  "cloud project ls": {
    usage: "pbc cloud project ls [--org <id>]",
    summary: "List projects.",
    args: [],
    flags: [{ name: "org", type: "string", required: false }],
  },
  "cloud project create": {
    usage: "pbc cloud project create <name>",
    summary: "Create a project.",
    args: [{ name: "name", required: true }],
    flags: [],
  },
  "cloud project use": {
    usage: "pbc cloud project use <name|id>",
    summary: "Set the current project.",
    args: [{ name: "name|id", required: true }],
    flags: [],
  },
  "cloud project rm": {
    usage: "pbc cloud project rm <name|id> [--yes]",
    summary: "Delete a project.",
    args: [{ name: "name|id", required: true }],
    flags: [],
  },
  "cloud link": {
    usage: "pbc cloud link [<pb|frontend|backend>] [<name|id>]",
    summary: "Link one environment of this directory to a cloud resource.",
    details:
      "Records the resource in ./pbc.json so deploy, info, rm, logs, and env\n" +
      "need no --name/--id when run here. Never creates or changes the cloud\n" +
      "resource itself.\n\n" +
      "With no arguments, pick from every resource in the project; with a kind\n" +
      "only, pick from that kind.\n\n" +
      "The link belongs to one environment — the file's default, or --env. On\n" +
      "a terminal, a directory that names no environment yet is asked which\n" +
      "one to record, defaulting to production.\n\n" +
      "Link a second environment to give this directory a second target:\n" +
      "  pbc cloud link frontend web-staging --env staging\n\n" +
      "For a pb or backend link, an environment with no envFile recorded yet is\n" +
      "also asked which dotenv file it uses (or none), the same question the\n" +
      "first deploy of that environment would ask — link only records the\n" +
      "answer in pbc.json, it never pushes. --env-file names one outright and\n" +
      "--skip-env asks nothing; both are no-ops once the environment already\n" +
      "has an answer recorded. Frontends have no env vars, so nothing is asked.",
    args: [
      { name: "kind", required: false },
      { name: "name|id", required: false },
    ],
    flags: [
      {
        name: "skip-env",
        type: "boolean",
        required: false,
        description: "Don't ask which env file this environment uses.",
      },
      {
        name: "env-file",
        type: "string",
        required: false,
        description:
          "Dotenv file to record for this environment when it has none yet.",
      },
    ],
  },
  "cloud unlink": {
    usage: "pbc cloud unlink [--all]",
    summary: "Forget one of this directory's environments.",
    details:
      "Clears the environment from ./pbc.json only — the cloud resource is left\n" +
      "untouched, as are the file's projectId, build block, and\n" +
      "pocketbaseVersion. --all forgets every environment at once.",
    args: [],
    flags: [{
      name: "all",
      type: "boolean",
      required: false,
      description: "Forget every environment, not just one.",
    }],
  },
  "cloud environments": {
    usage: "pbc cloud environments",
    summary: "List the environments recorded in ./pbc.json.",
    details:
      "Shows which cloud resource each environment of this directory deploys\n" +
      "to, and which one a bare deploy targets. Reads the file only — no\n" +
      "login, no network call.\n\n" +
      "Environments are created by deploying or linking with --env:\n" +
      "  pbc cloud frontend deploy --env staging --name web-staging",
    args: [],
    flags: [],
  },

  "cloud deploy": {
    usage: "pbc cloud deploy [pb|frontend|backend] [<name>] [<deploy flags>]",
    summary: "Deploy this directory, detecting what kind of resource it is.",
    details:
      `Works out whether the directory holds a PocketBase instance, a static
site, or a backend, then runs that kind's deploy — \`pbc cloud pb deploy\`,
\`pbc cloud frontend deploy\`, or \`pbc cloud backend deploy\`. Every flag those
commands accept works here and is passed straight through, and the deploy
itself is identical: this command only makes the choice.

The answer comes from the first of these that applies:

  1. The "kind" recorded in pbc.json, which a previous deploy or
     \`pbc cloud link\` wrote. A deployed directory is never re-guessed.
  2. A pb_hooks, pb_migrations, or pb_public directory — a PocketBase project.
  3. next.config.*, read for its "output": "export" builds a static site,
     anything else runs a Next.js server.
  4. vite / svelte / vue config, or angular.json — a frontend.
  5. deno.json(c) — a backend.
  6. package.json: a server dependency (express, fastify, hono, nest, …) is a
     backend and a bundler dependency (vite, react-scripts, parcel, …) is a
     frontend; failing both, a "start" script is a backend and a "build"
     script alone is a frontend.
  7. index.html in the directory or in public/, dist/, build/, or out/ —
     a frontend.

The detected kind and the file that decided it are printed before the deploy
runs, so a wrong guess is visible rather than surprising.

A leading kind word overrides the detection outright:

  pbc cloud deploy backend            # deploy as a backend, whatever is here
  pbc cloud deploy frontend web       # …and call the new resource "web"

When nothing in the directory points either way, you are asked on a terminal
and get an error naming the three explicit commands under --no-input or
--json.`,
    args: [
      {
        name: "kind",
        required: false,
        description:
          "pb, frontend, or backend; detected from the directory when omitted",
      },
      {
        name: "name",
        required: false,
        description: "Passed to the underlying deploy, same as --name",
      },
    ],
    flags: [],
  },

  "cloud init": {
    usage: "pbc cloud init [pb|frontend|backend] [--force]",
    summary: "Write this directory's build config into pbc.json.",
    details:
      `Inspects the directory and records how it should be built and packaged:
the build command, the output directory, the backend runtime, or a
PocketBase project's pb_public / pb_hooks / pb_migrations paths.

Deploy infers the same block when pbc.json has none, so this command is
optional — it just lets you see and edit the guess before anything ships.
Nothing in the cloud is touched, and no login is needed.

The kind comes from the argument, or from the directory's existing resource
binding. An existing block is left alone unless --force is passed.

On a terminal it also asks which environment this directory deploys to, and
records it as the default, so the first deploy has nothing left to ask.`,
    args: [{
      name: "kind",
      required: false,
      description: "pb, frontend, or backend; defaults to the bound resource",
    }],
    flags: [{
      name: "force",
      type: "boolean",
      required: false,
      description: "Overwrite an existing build block.",
    }],
  },

  "cloud ci init": {
    usage:
      "pbc cloud ci init [pb|frontend|backend] [--out <path>] [--branch <name>] [--force] [--env <name>]",
    summary: "Write a GitHub Actions workflow that deploys this directory.",
    details:
      `Writes .github/workflows/deploy.yml (or deploy-<path>.yml, when this
directory is not the repo root — nested folders become deploy-apps-web.yml),
using the official pocketbasecloud/cli/action. Nothing in the cloud is
touched, and no login is needed — like \`cloud init\`, it only inspects the
directory and the surrounding git repo.

The kind comes from the argument, or from pbc.json's existing binding. The
branch defaults to the one currently checked out; --branch overrides it.
--out picks a different file path. An existing file is left alone unless
--force is passed.

Prints the two remaining one-time steps: copying an access token from the
portal's Account page, and adding it as a repository secret named PBC_TOKEN.`,
    args: [{
      name: "kind",
      required: false,
      description: "pb, frontend, or backend; defaults to the bound resource",
    }],
    flags: [
      {
        name: "out",
        type: "string",
        required: false,
        description: "Workflow file path. Defaults under .github/workflows/.",
      },
      {
        name: "branch",
        type: "string",
        required: false,
        description:
          "Branch to deploy on push. Defaults to the branch currently " +
          "checked out.",
      },
      {
        name: "force",
        type: "boolean",
        required: false,
        description: "Overwrite an existing workflow file.",
      },
      {
        name: "env",
        type: "string",
        required: false,
        description:
          "pbc.json environment to pin in the workflow. Only --env is " +
          "written; PBC_ENV is ignored, because the answer is committed.",
      },
    ],
  },

  // PocketBase instances (cloud-managed)
  "cloud pb create": {
    usage:
      "pbc cloud pb create [<name>] [--env <name>] [--location <loc>] [--compute <id>] [--admin-email <e>] [--admin-password <p>] [--pb-version <v>] [--project <id>]",
    summary: "Create an empty PocketBase instance.",
    details: `Provisions a running instance with nothing deployed to it — no
pb_public, pb_hooks or pb_migrations — and waits until it answers.

Nothing is built, packaged, or uploaded, and no env file is asked about. Use it
to get a database from a script, from a directory that holds no project, or
before there is anything to deploy.

The new instance is recorded in this directory's pbc.json, under the environment
this command targets, exactly as a deploy would record it — so the next
\`pbc cloud pb deploy\` here needs no --name:

  pbc cloud pb create my-app-db
  pbc cloud pb deploy              # ships this directory to it

--env names the environment (default: production, or the file's own default).
A directory bound to frontends or backends is refused, and so is an environment
that already names an instance: repointing it would leave the old one with
nothing pointing at it. Pass --env <other>, or run this somewhere else.

\`pbc cloud pb deploy\` also creates an instance when there is none yet, and
creates it bare when the directory holds none of the three directories — so
this command is the explicit way to do the same thing when there is nothing to
package.

The name comes from the argument or --name, and is asked for on a terminal
(defaulting to the directory's name) when neither is given. A name already used
by an instance in this project is refused rather than duplicated: redeploy that
one with \`pbc cloud pb deploy --name <name>\` instead.

The instance gets a superuser account — your account email, and a generated
password printed once when it finishes (and readable afterwards with
\`pbc cloud pb info\`). Override either with --admin-email/--admin-password.

The compute is chosen exactly as a deploy chooses it: on Pro, and in a project
shared with an organization, the owner's compute is used, asked about when
there is more than one, and settled outright by --compute. On the free and
starter plans the platform picks from its shared pool.`,
    args: [{
      name: "name",
      required: false,
      description: "Positional name, alternative to --name",
    }],
    flags: [
      {
        name: "name",
        type: "string",
        required: false,
        description:
          "What to call the instance. Asked for on a terminal when omitted.",
      },
      {
        name: "env",
        type: "string",
        required: false,
        description:
          "Which pbc.json environment to record the instance under. Defaults " +
          "to the file's default, or production.",
      },
      {
        name: "location",
        type: "string",
        required: false,
        description:
          "Region for the instance, on Starter. Optional — without it the " +
          "platform picks the region with the most free capacity.",
      },
      {
        name: "compute",
        type: "string",
        required: false,
        description:
          "Compute to create the instance on. Asked for when the project owner " +
          "has more than one; required under --no-input/--json.",
      },
      {
        name: "admin-email",
        type: "string",
        required: false,
        description:
          "Superuser login for the new instance. Defaults to your account email.",
      },
      {
        name: "admin-password",
        type: "string",
        required: false,
        description:
          "Superuser password, 12-20 characters. Generated and printed once when omitted.",
      },
      {
        name: "pb-version",
        type: "string",
        required: false,
        description:
          "PocketBase release to install. Defaults to pocketbaseVersion in pbc.json.",
      },
    ],
  },
  "cloud pb deploy": {
    usage:
      "pbc cloud pb deploy [--name <name>] [--location <loc>] [--compute <id>] [--admin-email <e>] [--admin-password <p>] [--pb-version <v>] [--skip-env] [--project <id>]",
    summary: "Create or redeploy a PocketBase instance.",
    details:
      `Packages pb_public, pb_hooks, and pb_migrations and ships them with the
instance. Their locations come from the "build" block in pbc.json, which
is inferred from the directory and written there on the first deploy.

A redeploy ships them too: the .js and .json files in pb_hooks go through the
hooks route (which keeps the portal's editor in sync), and the archive's
pb_migrations and pb_public are installed on the running instance — migrations
merged with the ones already there, pb_public replaced wholesale. New
migrations are applied by the restart that follows.

Hooks are stored as flat files, so a subdirectory of pb_hooks is not uploaded
and the deploy says which ones it skipped.

None of the three directories is required. A directory that holds none of them
still deploys: no archive is sent at all, a new instance is created empty, and
the deploy says so rather than reporting a silent success. \`pbc cloud pb create\`
does the same thing without involving a directory.

A new instance gets a superuser account: your account email, and a generated
password printed once when the deploy finishes (and readable afterwards with
\`pbc cloud pb info\`). Override either with --admin-email/--admin-password.

Each wait — installing, building, packaging, uploading, provisioning, waiting
for the domain — is reported as its own step, with a spinner and the elapsed
time on a terminal, plain lines when the output is piped, and nothing at all
under --json.

Env vars are pushed only from the file you name — nothing is uploaded by
default. Each environment has its own: the first deploy of an environment asks
which dotenv file it uses (or none) and records the answer as envFile under
that environment in pbc.json, so it is asked once. --env-file names one outright
and is recorded the same way when the environment has none yet. Pushing merges,
keeping cloud-only keys; --delete-missing removes them so the file is the whole
truth, and --skip-env pushes nothing for this run. A file whose variables are
unchanged since the last push is not uploaded again — pass --force-env to push
it anyway, e.g. after editing the variables in the portal.

With no --name and nothing bound in pbc.json, deploy asks which instance to
redeploy — or what to call a new one — the way it already asks which project
to use. Pass --no-input (or --json) to get the usage error instead.

Creating an instance also picks the compute it runs on, whenever there is a
choice to make: on Pro, and in a project shared with an organization, where the
compute is the owner's. One compute is used without asking, several are offered
as a menu, and --compute settles it outright. On the free and starter plans the
platform picks from the shared pool and the flag is unnecessary. A redeploy
never moves an existing instance.`,
    args: [],
    flags: [
      {
        name: "name",
        type: "string",
        required: false,
        description:
          "Which PocketBase to deploy. Asked for when omitted and pbc.json has no binding.",
      },
      {
        name: "location",
        type: "string",
        required: false,
        description:
          "Region for the deploy, on Starter. Optional — without it the " +
          "platform picks the region with the most free capacity.",
      },
      {
        name: "compute",
        type: "string",
        required: false,
        description:
          "Compute to create the instance on. Asked for when the project owner " +
          "has more than one; required under --no-input/--json.",
      },
      {
        name: "admin-email",
        type: "string",
        required: false,
        description:
          "Superuser login for the new instance. Defaults to your account email.",
      },
      {
        name: "admin-password",
        type: "string",
        required: false,
        description:
          "Superuser password, 12-20 characters. Generated and printed once when omitted.",
      },
      {
        name: "pb-version",
        type: "string",
        required: false,
        description:
          "PocketBase release to install. Defaults to pocketbaseVersion in pbc.json.",
      },
      {
        name: "skip-build",
        type: "boolean",
        required: false,
        description: "Package without running the build command.",
      },
      {
        name: "skip-env",
        type: "boolean",
        required: false,
        description:
          "Push no env vars for this run, whatever pbc.json configures.",
      },
      {
        name: "env-file",
        type: "string",
        required: false,
        description:
          "Dotenv file to push. Recorded in pbc.json for this environment " +
          "when it has none yet.",
      },
      {
        name: "delete-missing",
        type: "boolean",
        required: false,
        description: "Remove cloud env vars the pushed file does not list.",
      },
      {
        name: "force-env",
        type: "boolean",
        required: false,
        description:
          "Push env vars even when they are unchanged since the last push.",
      },
      {
        name: "zip",
        type: "string",
        required: false,
        description: "Upload this archive instead of packaging the directory.",
      },
    ],
  },
  "cloud pb ls": {
    usage: "pbc cloud pb ls [--project <id>]",
    summary: "List PocketBase instances in a project.",
    args: [],
    flags: [],
  },
  "cloud pb info": {
    usage:
      "pbc cloud pb info (<name>|--name <name>|--id <id>) [--project <id>]",
    summary: "Show PocketBase instance details.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{
      name: "name",
      required: false,
      description: "Positional name, alternative to --name/--id",
    }],
    flags: [
      { name: "name", type: "string", required: false },
      { name: "id", type: "string", required: false },
    ],
  },
  "cloud pb rm": {
    usage: "pbc cloud pb rm (<name>|--name <name>|--id <id>) [--yes]",
    summary: "Delete a PocketBase instance.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{
      name: "name",
      required: false,
      description: "Positional name, alternative to --name/--id",
    }],
    flags: [
      { name: "name", type: "string", required: false },
      { name: "id", type: "string", required: false },
    ],
  },
  "cloud pb hooks push": {
    usage: "pbc cloud pb hooks push <dir> [--name <instance>] [--project <id>]",
    summary: "Upload every .js and .json file in <dir> as a hook.",
    details:
      `Hooks belong to one PocketBase instance. Name it with --name/--id, or let
the directory's pbc.json binding pick it.

PocketBase itself only runs *.pb.js, but the plain .js and .json files beside
them are uploaded too — a hook that requires a helper module or a data file
needs it on the instance. Subdirectories are not uploaded: the platform stores
hooks as flat files. At most 30 files per push — a bigger directory is nearly
always the wrong one.`,
    args: [{ name: "dir", required: true }],
    flags: [{ name: "name", type: "string", required: false }],
  },
  "cloud pb hooks ls": {
    usage: "pbc cloud pb hooks ls [--name <instance>] [--project <id>]",
    summary: "List uploaded hook files.",
    details:
      "Lists hooks uploaded with `pbc cloud pb hooks push`. Hooks shipped\n" +
      "inside a deploy archive (pb_hooks/ packaged by `pbc cloud pb deploy`)\n" +
      "run on the instance but are not recorded here, so this can read empty\n" +
      "while hooks are live. Push them to manage them from the CLI.",
    args: [],
    flags: [{ name: "name", type: "string", required: false }],
  },
  "cloud pb hooks rm": {
    usage:
      "pbc cloud pb hooks rm <filename> [--name <instance>] [--project <id>]",
    summary: "Delete a hook file.",
    args: [{ name: "filename", required: true }],
    flags: [{ name: "name", type: "string", required: false }],
  },
  "cloud pb domain add": {
    usage:
      "pbc cloud pb domain add <domain> [--name <instance>] [--project <id>]",
    summary: "Add a custom domain.",
    args: [{ name: "domain", required: true }],
    flags: [{ name: "name", type: "string", required: false }],
  },
  "cloud pb domain verify": {
    usage:
      "pbc cloud pb domain verify <domain> [--name <instance>] [--project <id>]",
    summary: "Verify a custom domain.",
    args: [{ name: "domain", required: true }],
    flags: [{ name: "name", type: "string", required: false }],
  },
  "cloud pb domain remove": {
    usage:
      "pbc cloud pb domain remove <domain> [--name <instance>] [--project <id>]",
    summary: "Remove a custom domain.",
    args: [{ name: "domain", required: true }],
    flags: [{ name: "name", type: "string", required: false }],
  },

  // Frontends
  "cloud frontend deploy": {
    usage:
      "pbc cloud frontend deploy [--name <name>] [--skip-build] [--zip <file>] [--location <loc>] [--compute <id>]",
    summary: "Build, package, and deploy a static site.",
    details:
      `Runs the build command, zips the output directory, and uploads it. Both
come from the "build" block in pbc.json, which is inferred from the directory
(vite/svelte/angular/next config, package.json build script) and written there
on the first deploy.

A build needs its dependencies, so deploy installs them first when something
package.json declares is not installed — with the package manager the lockfile
names, at the workspace root when the project is one. A tree that is already
installed is left alone; "install" in the build block sets the command outright,
and "" turns the step off.

Each wait — installing, building, packaging, uploading, provisioning, waiting
for the domain — is reported as its own step, with a spinner and the elapsed
time on a terminal, plain lines when the output is piped, and nothing at all
under --json.

Frontends have no cloud env store — build-time variables are baked into the
bundle, so --env-file is rejected here.

A site is served from an address the platform assigns and never changes:
<id>.<compute>.pocketbasecloud.com. To put a domain of your own in front of it,
use pbc cloud frontend domain add.

With no --name and nothing bound in pbc.json, deploy asks which frontend to
redeploy — or what to call a new one — the way it already asks which project
to use. Pass --no-input (or --json) to get the usage error instead.

Creating a site also picks the compute it runs on, whenever there is a choice to
make: on Pro, and in a project shared with an organization, where the compute is
the owner's. One compute is used without asking, several are offered as a menu,
and --compute settles it outright. On the free and starter plans the platform
picks from the shared pool and the flag is unnecessary. A redeploy never moves
an existing site.`,
    args: [],
    flags: [
      {
        name: "name",
        type: "string",
        required: false,
        description:
          "Which frontend to deploy. Asked for when omitted and pbc.json has no binding.",
      },
      {
        name: "zip",
        type: "string",
        required: false,
        description: "Upload this archive instead of building and packaging.",
      },
      {
        name: "skip-build",
        type: "boolean",
        required: false,
        description: "Package the output directory without rebuilding it.",
      },
      {
        name: "location",
        type: "string",
        required: false,
        description:
          "Region for the deploy, on Starter. Optional — without it the " +
          "platform picks the region with the most free capacity.",
      },
      {
        name: "compute",
        type: "string",
        required: false,
        description:
          "Compute to create the site on. Asked for when the project owner " +
          "has more than one; required under --no-input/--json.",
      },
    ],
  },
  "cloud frontend ls": {
    usage: "pbc cloud frontend ls [--project <id>]",
    summary: "List frontends.",
    args: [],
    flags: [],
  },
  "cloud frontend info": {
    usage: "pbc cloud frontend info (<name>|--name <name>|--id <id>)",
    summary: "Show frontend details.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{
      name: "name",
      required: false,
      description: "Positional name, alternative to --name/--id",
    }],
    flags: [
      { name: "name", type: "string", required: false },
      { name: "id", type: "string", required: false },
    ],
  },
  "cloud frontend rm": {
    usage: "pbc cloud frontend rm (<name>|--name <name>|--id <id>) [--yes]",
    summary: "Delete a frontend.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{
      name: "name",
      required: false,
      description: "Positional name, alternative to --name/--id",
    }],
    flags: [
      { name: "name", type: "string", required: false },
      { name: "id", type: "string", required: false },
    ],
  },
  "cloud frontend domain add": {
    usage: "pbc cloud frontend domain add <domain> --name <site>",
    summary: "Add a custom domain.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{ name: "domain", required: true }],
    flags: [{ name: "name", type: "string", required: true }],
  },
  "cloud frontend domain verify": {
    usage: "pbc cloud frontend domain verify <domain> --name <site>",
    summary: "Verify a custom domain.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{ name: "domain", required: true }],
    flags: [{ name: "name", type: "string", required: true }],
  },
  "cloud frontend domain remove": {
    usage: "pbc cloud frontend domain remove <domain> --name <site>",
    summary: "Remove a custom domain.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{ name: "domain", required: true }],
    flags: [{ name: "name", type: "string", required: true }],
  },

  // Backends
  "cloud backend deploy": {
    usage:
      "pbc cloud backend deploy [--name <name>] [--runtime <deno|bun|nodejs|nextjs>] [--start <cmd>] [--compute <id>] [--skip-env] [--zip <file>]",
    summary: "Build, package, and deploy a backend.",
    details:
      `Runs the build command and uploads the result. The runtime, build command,
and output directory come from the "build" block in pbc.json, inferred from the
directory (deno.json, bun.lockb, next.config.*, package.json) and written there
on the first deploy.

deno, bun, and nodejs ship their source — the platform installs dependencies on
start, so node_modules is excluded.

Where there is a build command, it needs its dependencies, so deploy installs
them first when something package.json declares is not installed — with the
package manager the lockfile names, at the workspace root when the project is
one. This is what keeps a Next.js deploy from a fresh clone or a CI runner from
dying on "next: not found". A tree that is already installed is left alone;
"install" in the build block sets the command outright, and "" turns the step
off.

nextjs ships a prebuilt bundle: the platform does not run next build (it
exhausts memory on a shared host). That bundle only exists when the build asks
for it, so deploy adds output: "standalone" to next.config.* before building
(creating the file if the project has none) and says so — the CLI then
assembles .next/standalone, .next/static, and public into the layout the
runtime expects, defaulting the start command to "node server.js". A config
that already sets output is left alone; output: "export" is a static site, so
deploy it with "pbc cloud frontend deploy" instead.

Each wait — installing, building, packaging, uploading, provisioning, waiting
for the domain — is reported as its own step, with a spinner and the elapsed
time on a terminal, plain lines when the output is piped, and nothing at all
under --json.

Env vars are pushed only from the file you name — nothing is uploaded by
default. Each environment has its own: the first deploy of an environment asks
which dotenv file it uses (or none) and records the answer as envFile under
that environment in pbc.json, so it is asked once. --env-file names one outright
and is recorded the same way when the environment has none yet. Pushing merges,
keeping cloud-only keys; --delete-missing removes them so the file is the whole
truth, and --skip-env pushes nothing for this run. A file whose variables are
unchanged since the last push is not uploaded again — pass --force-env to push
it anyway, e.g. after editing the variables in the portal.

With no --name and nothing bound in pbc.json, deploy asks which backend to
redeploy — or what to call a new one — the way it already asks which project
to use. Pass --no-input (or --json) to get the usage error instead.

Creating a backend also picks the compute it runs on: the project owner's, so
a developer in a shared organization project deploys onto the owner's Pro
compute (and against the owner's plan) without needing to see it. A single
compute is used, several are offered as a menu, and --compute settles it
outright. A redeploy never moves an existing backend.`,
    args: [],
    flags: [
      {
        name: "name",
        type: "string",
        required: false,
        description:
          "Which backend to deploy. Asked for when omitted and pbc.json has no binding.",
      },
      {
        name: "runtime",
        type: "string",
        required: false,
        choices: ["deno", "bun", "nodejs", "nextjs"],
        description: "Defaults to build.runtime in pbc.json, else inferred.",
      },
      { name: "start", type: "string", required: false },
      {
        name: "compute",
        type: "string",
        required: false,
        description:
          "Compute to create the backend on. Asked for when the project owner " +
          "has more than one; required under --no-input/--json.",
      },
      {
        name: "zip",
        type: "string",
        required: false,
        description: "Upload this archive instead of building and packaging.",
      },
      {
        name: "skip-build",
        type: "boolean",
        required: false,
        description: "Package without running the build command.",
      },
      {
        name: "skip-env",
        type: "boolean",
        required: false,
        description:
          "Push no env vars for this run, whatever pbc.json configures.",
      },
      {
        name: "env-file",
        type: "string",
        required: false,
        description:
          "Dotenv file to push. Recorded in pbc.json for this environment " +
          "when it has none yet.",
      },
      {
        name: "delete-missing",
        type: "boolean",
        required: false,
        description: "Remove cloud env vars the pushed file does not list.",
      },
      {
        name: "force-env",
        type: "boolean",
        required: false,
        description:
          "Push env vars even when they are unchanged since the last push.",
      },
    ],
  },
  "cloud backend ls": {
    usage: "pbc cloud backend ls [--project <id>]",
    summary: "List backends.",
    args: [],
    flags: [],
  },
  "cloud backend info": {
    usage: "pbc cloud backend info (<name>|--name <name>|--id <id>)",
    summary: "Show backend details.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{
      name: "name",
      required: false,
      description: "Positional name, alternative to --name/--id",
    }],
    flags: [
      { name: "name", type: "string", required: false },
      { name: "id", type: "string", required: false },
    ],
  },
  "cloud backend rm": {
    usage: "pbc cloud backend rm (<name>|--name <name>|--id <id>) [--yes]",
    summary: "Delete a backend.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{
      name: "name",
      required: false,
      description: "Positional name, alternative to --name/--id",
    }],
    flags: [
      { name: "name", type: "string", required: false },
      { name: "id", type: "string", required: false },
    ],
  },

  // Env vars
  "cloud env ls": {
    usage: "pbc cloud env ls --target pb|backend --name <n>",
    summary: "List environment variables.",
    details:
      "Names only. The platform stores values encrypted and its list endpoint\n" +
      "never returns plaintext, so there is nothing for the CLI to show —\n" +
      "read a value from the app itself, or overwrite it with `env set`.\n" +
      "Without --name/--id, a terminal offers a picker.",
    args: [],
    flags: [
      {
        name: "target",
        type: "string",
        required: true,
        choices: ["pb", "backend"],
      },
      { name: "name", type: "string", required: true },
    ],
  },
  "cloud env set": {
    usage: "pbc cloud env set KEY=VALUE --target pb|backend --name <n>",
    summary: "Set an environment variable.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{ name: "KEY=VALUE", required: true }],
    flags: [
      {
        name: "target",
        type: "string",
        required: true,
        choices: ["pb", "backend"],
      },
      { name: "name", type: "string", required: true },
    ],
  },
  "cloud env rm": {
    usage: "pbc cloud env rm KEY --target pb|backend --name <n>",
    summary: "Remove an environment variable.",
    details: "Without --name/--id, a terminal offers a picker.",
    args: [{ name: "KEY", required: true }],
    flags: [
      {
        name: "target",
        type: "string",
        required: true,
        choices: ["pb", "backend"],
      },
      { name: "name", type: "string", required: true },
    ],
  },
  "cloud env import": {
    usage:
      "pbc cloud env import <.env> --target pb|backend --name <n> [--delete-missing]",
    summary: "Bulk-import variables from a .env file.",
    details:
      `Merges by default: keys in the file are written, keys only in the cloud
are left alone. Pass --delete-missing to make the file the whole truth — cloud
variables it does not list are removed from the instance too, which asks for
confirmation unless --yes is given. --no-input does not waive it: without a way
to ask, the import stops and names --yes.

Without --name/--id, a terminal offers a picker.`,
    args: [{ name: ".env", required: true }],
    flags: [
      {
        name: "target",
        type: "string",
        required: true,
        choices: ["pb", "backend"],
      },
      { name: "name", type: "string", required: true },
      {
        name: "delete-missing",
        type: "boolean",
        required: false,
        description: "Remove cloud variables the file does not list.",
      },
    ],
  },

  // Data
  "cloud data export": {
    usage:
      "pbc cloud data export [--name <instance>] [--out <file.zip>] [--project <id>]",
    summary: "Export a PocketBase instance's data.",
    details:
      `The platform builds the archive and hands back a link; the CLI downloads
it. Defaults to the file name the platform chose, in the current directory.`,
    args: [],
    flags: [
      { name: "name", type: "string", required: false },
      { name: "out", type: "string", required: false },
    ],
  },
  "cloud data import": {
    usage: "pbc cloud data import <file>",
    summary: "Not implemented — use the portal's import dialog.",
    details:
      `The platform's import needs a target collection and a per-field mapping,
which this command has no way to ask for yet. It reports that rather than
sending a request that cannot succeed.`,
    args: [{ name: "file", required: true }],
    flags: [],
  },

  // Logs (cloud)
  "cloud logs": {
    usage:
      "pbc cloud logs <pb|backend> --name <n> [-f] [--lines <n>] [--project <id>]",
    summary: "Stream logs for a PocketBase instance or backend.",
    details:
      `Prints the last --lines entries (50 by default, 1000 max) and stops. With
--follow it keeps printing until interrupted, since the platform tails the
container for as long as the connection is open.

Without --name/--id, a terminal offers a picker.`,
    args: [{ name: "pb|backend", required: true }],
    flags: [
      { name: "name", type: "string", required: true },
      { name: "follow", type: "boolean", required: false },
      {
        name: "lines",
        type: "string",
        required: false,
        description: "How much history to print first. 1-1000, default 50.",
      },
    ],
  },

  // Compute
  "cloud compute ls": {
    usage: "pbc cloud compute ls",
    summary: "List the compute your account can deploy to.",
    details:
      "Compute is provisioned by the platform, not the CLI. This lists your\n" +
      "account's own dedicated compute — the ids `--compute <id>` accepts on a\n" +
      "deploy. The shared pool is not listed: on every plan except Pro the\n" +
      "platform picks from it by capacity and the flag is unnecessary.\n\n" +
      "`pbc cloud server ls` is the same command under its former name.",
    args: [],
    flags: [],
  },
  "cloud server ls": {
    usage: "pbc cloud server ls",
    summary:
      "List the compute your account can deploy to (alias of compute ls).",
    args: [],
    flags: [],
  },

  // Locations
  "cloud locations": {
    usage: "pbc cloud locations [--project <id>]",
    summary: "List the regions a deploy can actually land in.",
    details:
      "The regions of the shared platform pool for the plan a deploy is placed\n" +
      "against — what `--location <loc>` accepts on `pb create` and\n" +
      "`cloud frontend deploy`. Not the provider catalog: most regions a\n" +
      "provider sells hold no server of ours, and a deploy aimed at one fails\n" +
      "with `noServerAvailable`.\n\n" +
      "With `--project`, the answer is for that project's owner (org-aware);\n" +
      "without it, for the caller.",
    args: [],
    // `--project` is a global flag, documented once in the global list — a
    // command spec that repeats one fails `usage.test.ts`.
    flags: [],
  },

  // Orgs
  "cloud org ls": {
    usage: "pbc cloud org ls",
    summary: "List organizations.",
    args: [],
    flags: [],
  },
  "cloud org create": {
    usage: "pbc cloud org create <name>",
    summary: "Create an organization.",
    args: [{ name: "name", required: true }],
    flags: [],
  },
  "cloud org rm": {
    usage: "pbc cloud org rm <orgId> [--yes]",
    summary: "Delete an organization.",
    args: [{ name: "orgId", required: true }],
    flags: [],
  },
  "cloud org members ls": {
    usage: "pbc cloud org members ls <orgId>",
    summary: "List organization members.",
    args: [{ name: "orgId", required: true }],
    flags: [],
  },
  "cloud org members add": {
    usage: "pbc cloud org members add <orgId> <email>",
    summary: "Add a member.",
    args: [{ name: "orgId", required: true }, {
      name: "email",
      required: true,
    }],
    flags: [],
  },
  "cloud org members rm": {
    usage: "pbc cloud org members rm <orgId> <email>",
    summary: "Remove a member.",
    args: [{ name: "orgId", required: true }, {
      name: "email",
      required: true,
    }],
    flags: [],
  },
  "cloud org share": {
    usage: "pbc cloud org share <project> (--org <id>|--none)",
    summary: "Share a project with an org, or unshare it with --none.",
    args: [{ name: "project", required: true }],
    flags: [
      { name: "org", type: "string", required: false },
      { name: "none", type: "boolean", required: false },
    ],
  },

  "cloud upgrade": {
    usage: "pbc cloud upgrade",
    summary: "Show the current plan and the upgrade link.",
    details: "Upgrades your account's plan. To update the pbc binary itself, " +
      "see `pbc upgrade`.",
    args: [],
    flags: [],
  },

  // Instance selection & auth
  "use": {
    usage: "pbc use <url> [--name <profile>]",
    summary: "Select a PocketBase instance.",
    args: [{ name: "url", required: true }],
    flags: [{ name: "name", type: "string", required: false }],
  },
  "login": {
    usage: "pbc login [--email <e>] [--password <p>] [--profile <name>]",
    summary: "Log in as the instance superuser.",
    args: [],
    flags: [
      { name: "email", type: "string", required: false },
      { name: "password", type: "string", required: false },
    ],
  },
  "logout": {
    usage: "pbc logout [--remove] [--profile <name>]",
    summary:
      "Log out of the current instance profile. --remove also forgets it.",
    args: [],
    flags: [{ name: "remove", type: "boolean", required: false }],
  },
  "whoami": {
    usage: "pbc whoami [--profile <name>]",
    summary: "Show the active instance profile.",
    args: [],
    flags: [],
  },

  // Collections
  "collections ls": {
    usage: "pbc collections ls",
    summary: "List collections.",
    args: [],
    flags: [],
  },
  "collections get": {
    usage: "pbc collections get <idOrName>",
    summary: "Show a collection.",
    args: [{ name: "idOrName", required: true }],
    flags: [],
  },
  "collections create": {
    usage: "pbc collections create <name> [--type base|auth|view]",
    summary: "Create a collection.",
    args: [{ name: "name", required: true }],
    flags: [{
      name: "type",
      type: "string",
      required: false,
      choices: ["base", "auth", "view"],
    }],
  },
  "collections update": {
    usage: "pbc collections update <idOrName> '<json>'",
    summary: "Update a collection.",
    args: [{ name: "idOrName", required: true }, {
      name: "json",
      required: true,
    }],
    flags: [],
  },
  "collections rm": {
    usage: "pbc collections rm <idOrName> [--yes]",
    summary: "Delete a collection.",
    args: [{ name: "idOrName", required: true }],
    flags: [],
  },
  "collections export": {
    usage: "pbc collections export [--out <file>]",
    summary: "Export all collections to JSON.",
    args: [],
    flags: [{ name: "out", type: "string", required: false }],
  },
  "collections import": {
    usage: "pbc collections import <file.json> [--delete-missing]",
    summary:
      "Import collections from JSON. --delete-missing drops collections not in the file.",
    args: [{ name: "file.json", required: true }],
    flags: [{ name: "delete-missing", type: "boolean", required: false }],
  },

  // Records
  "records ls": {
    usage:
      "pbc records ls <collection> [--filter <expr>] [--sort <expr>] [--page <n>] [--per-page <n>]",
    summary: "List records in a collection.",
    args: [{ name: "collection", required: true }],
    flags: [
      { name: "filter", type: "string", required: false },
      { name: "sort", type: "string", required: false },
      { name: "page", type: "string", required: false },
      { name: "per-page", type: "string", required: false },
    ],
  },
  "records get": {
    usage: "pbc records get <collection> <id>",
    summary: "Show a record.",
    args: [{ name: "collection", required: true }, {
      name: "id",
      required: true,
    }],
    flags: [],
  },
  "records create": {
    usage: "pbc records create <collection> '<json>'",
    summary: "Create a record.",
    args: [{ name: "collection", required: true }, {
      name: "json",
      required: true,
    }],
    flags: [],
  },
  "records update": {
    usage: "pbc records update <collection> <id> '<json>'",
    summary: "Update a record.",
    args: [
      { name: "collection", required: true },
      { name: "id", required: true },
      { name: "json", required: true },
    ],
    flags: [],
  },
  "records rm": {
    usage: "pbc records rm <collection> <id> [--yes]",
    summary: "Delete a record.",
    args: [{ name: "collection", required: true }, {
      name: "id",
      required: true,
    }],
    flags: [],
  },

  // Rules
  "rules get": {
    usage: "pbc rules get <collection>",
    summary: "Show API rules.",
    args: [{ name: "collection", required: true }],
    flags: [],
  },
  "rules set": {
    usage:
      "pbc rules set <collection> [--list-rule <expr>] [--view-rule <expr>] " +
      "[--create-rule <expr>] [--update-rule <expr>] [--delete-rule <expr>]",
    summary: "Update API rules. Pass 'null' as a value to clear a rule.",
    args: [{ name: "collection", required: true }],
    flags: [
      { name: "list-rule", type: "string", required: false },
      { name: "view-rule", type: "string", required: false },
      { name: "create-rule", type: "string", required: false },
      { name: "update-rule", type: "string", required: false },
      { name: "delete-rule", type: "string", required: false },
    ],
  },

  // Auth collection config
  "auth": {
    usage: "pbc auth <collection> config [--set '<field>=<json>']",
    summary: "View or edit an auth collection's auth-related settings.",
    details:
      "Without --set, prints the current value of: authRule, manageRule, authAlert,\n" +
      "oauth2, passwordAuth, mfa, otp, verificationTemplate, resetPasswordTemplate.\n\n" +
      "With --set '<field>=<json>', replaces that one field's value entirely — run\n" +
      "without --set first if the field (e.g. oauth2.providers) already has content\n" +
      "you need to keep, and include it in the json you send.\n\n" +
      "Examples:\n" +
      "  pbc auth users config\n" +
      '  pbc auth users config --set \'passwordAuth={"enabled":true,"identityFields":["email"]}\'\n\n' +
      '  Enable Google sign-in on the "users" collection (get clientId/clientSecret\n' +
      "  from a Google Cloud OAuth 2.0 Client ID, with authorized redirect URI\n" +
      "  <your-instance-url>/api/oauth2-redirect):\n" +
      '    pbc auth users config --set \'oauth2={"enabled":true,"providers":' +
      '[{"name":"google","clientId":"<GOOGLE_CLIENT_ID>.apps.googleusercontent.com",' +
      '"clientSecret":"<GOOGLE_CLIENT_SECRET>"}]}' + "'\n\n" +
      "  Add Google alongside an existing provider — include every provider you\n" +
      "  want to keep, since the json replaces the whole oauth2 field:\n" +
      '    pbc auth users config --set \'oauth2={"enabled":true,"providers":' +
      '[{"name":"github","clientId":"<GITHUB_CLIENT_ID>","clientSecret":"<GITHUB_CLIENT_SECRET>"},' +
      '{"name":"google","clientId":"<GOOGLE_CLIENT_ID>.apps.googleusercontent.com",' +
      '"clientSecret":"<GOOGLE_CLIENT_SECRET>"}]}' + "'",
    args: [
      { name: "collection", required: true },
      {
        name: "config",
        required: true,
        description: "Literal subcommand keyword",
      },
    ],
    flags: [{ name: "set", type: "string", required: false }],
  },

  // Settings
  "settings get": {
    usage: "pbc settings get",
    summary: "Show all instance settings.",
    args: [],
    flags: [],
  },
  "settings mail": {
    usage: "pbc settings mail",
    summary: "Show SMTP settings.",
    args: [],
    flags: [],
  },
  "settings mail set": {
    usage: "pbc settings mail set '<json>'",
    summary: "Update SMTP settings.",
    args: [{ name: "json", required: true }],
    flags: [],
  },
  "settings mail test": {
    usage: "pbc settings mail test <email>",
    summary: "Send a test email.",
    args: [{ name: "email", required: true }],
    flags: [],
  },
  "settings s3": {
    usage: "pbc settings s3",
    summary: "Show S3 storage settings.",
    args: [],
    flags: [],
  },
  "settings s3 set": {
    usage: "pbc settings s3 set '<json>'",
    summary: "Update S3 storage settings.",
    args: [{ name: "json", required: true }],
    flags: [],
  },
  "settings s3 test": {
    usage: "pbc settings s3 test",
    summary: "Test the S3 connection.",
    args: [],
    flags: [],
  },
  "settings backup ls": {
    usage: "pbc settings backup ls",
    summary: "List backups.",
    args: [],
    flags: [],
  },
  "settings backup create": {
    usage: "pbc settings backup create [<name>]",
    summary: "Create a backup.",
    args: [{ name: "name", required: false }],
    flags: [],
  },
  "settings backup rm": {
    usage: "pbc settings backup rm <key> [--yes]",
    summary: "Delete a backup.",
    args: [{ name: "key", required: true }],
    flags: [],
  },
  "settings backup download": {
    usage: "pbc settings backup download <key> [--out <file>]",
    summary: "Download a backup.",
    args: [{ name: "key", required: true }],
    flags: [{ name: "out", type: "string", required: false }],
  },

  // Cron
  "cron ls": {
    usage: "pbc cron ls",
    summary: "List cron jobs.",
    args: [],
    flags: [],
  },
  "cron run": {
    usage: "pbc cron run <jobId>",
    summary: "Run a cron job now.",
    args: [{ name: "jobId", required: true }],
    flags: [],
  },

  // Local PocketBase binary
  "init": {
    usage: "pbc init [<version>] [--dir <d>] [--force]",
    summary: "Download a PocketBase binary and scaffold a local project.",
    details:
      "Downloads the binary for this OS and CPU, then creates pb_hooks/,\n" +
      "pb_migrations/, a README.md, .gitignore entries (which exclude the\n" +
      "binary and pb_data/), and a pocketbaseVersion pin in pbc.json. Existing\n" +
      "files are never overwritten. Omit <version> for the latest release;\n" +
      "--force re-downloads the binary only.\n\n" +
      "Start the instance afterwards with `./pocketbase serve`.",
    args: [{
      name: "version",
      required: false,
      description: "Release to install, e.g. 0.39.9. Defaults to latest.",
    }],
    flags: [
      { name: "dir", type: "string", required: false },
      { name: "force", type: "boolean", required: false },
    ],
  },
  "install": {
    usage:
      "pbc install [<version>] [--dir <d>] [--force] [--os <o>] [--arch <a>]",
    summary: "Download a PocketBase binary and record the version pin.",
    details:
      "Like `pbc init` without the scaffolding. --os/--arch override platform\n" +
      "detection to fetch a build for another machine.\n\n" +
      "Start the instance afterwards with `./pocketbase serve`.",
    args: [{
      name: "version",
      required: false,
      description: "Release to install, e.g. 0.39.9. Defaults to latest.",
    }],
    flags: [
      { name: "dir", type: "string", required: false },
      { name: "force", type: "boolean", required: false },
      {
        name: "os",
        type: "string",
        required: false,
        choices: ["darwin", "linux", "windows"],
      },
      {
        name: "arch",
        type: "string",
        required: false,
        choices: ["amd64", "arm64", "armv7", "ppc64le", "s390x"],
      },
    ],
  },
  "versions": {
    usage: "pbc versions [--all] [--pre] [--json]",
    summary: "List available PocketBase versions.",
    details:
      "Reads the live GitHub releases. Shows the 20 newest by semver; --all\n" +
      "lists every release and --pre includes prereleases. Falls back to a\n" +
      "built-in list, clearly labelled, when GitHub is unreachable.",
    args: [],
    flags: [
      { name: "all", type: "boolean", required: false },
      { name: "pre", type: "boolean", required: false },
    ],
  },
  "which": {
    usage: "pbc which [--dir <d>]",
    summary: "Show the installed PocketBase binary and its pinned version.",
    args: [],
    flags: [{ name: "dir", type: "string", required: false }],
  },

  // The CLI itself
  "upgrade": {
    usage: "pbc upgrade [<version>] [--check] [--force] [--json]",
    summary: "Update pbc itself to the latest release.",
    details:
      "Downloads the release archive for this OS and CPU, verifies its\n" +
      "SHA-256 against the release's checksums.txt, and replaces the running\n" +
      "binary. Nothing is changed unless the checksum matches.\n\n" +
      "Pass a <version> to install a specific release, including an older one\n" +
      "to roll back. --check reports what is available without installing;\n" +
      "--force reinstalls the version you already have.\n\n" +
      "Only a standalone binary (the `curl | sh` installer, or a release\n" +
      "archive) can be replaced in place. An npm install must be updated with\n" +
      "npm, and a from-source install by updating its clone; in both cases\n" +
      "`pbc upgrade` prints the exact command and exits non-zero.\n\n" +
      "pbc also looks for a newer release once a day on its own and mentions\n" +
      "one on stderr after a command finishes. Set PBC_NO_UPDATE_CHECK to turn\n" +
      "that off; it is already skipped under --json, CI, and redirected\n" +
      "output.\n\n" +
      "To change your plan, see `pbc cloud upgrade` instead.",
    args: [{
      name: "version",
      required: false,
      description: "Release to install, e.g. 0.2.4. Defaults to the latest.",
    }],
    flags: [
      {
        name: "check",
        type: "boolean",
        required: false,
        description: "Report the available version without installing it",
      },
      {
        name: "force",
        type: "boolean",
        required: false,
        description: "Reinstall even when already on the target version",
      },
    ],
  },

  // Instance logs
  "logs": {
    usage: "pbc logs [--filter <expr>] [--page <n>] [--per-page <n>] [-f]",
    summary: "Show instance request logs. -f follows new entries.",
    args: [],
    flags: [
      { name: "filter", type: "string", required: false },
      { name: "page", type: "string", required: false },
      { name: "per-page", type: "string", required: false },
      { name: "follow", type: "boolean", required: false },
    ],
  },
};

/**
 * Every command that resolves a cloud resource through pbc.json, and so picks
 * one of its environments. Listed once and applied below rather than repeated
 * in fifteen flag arrays, which is how one of them ends up out of step.
 */
const ENV_AWARE = [
  "cloud init",
  "cloud link",
  "cloud unlink",
  "cloud pb deploy",
  "cloud pb info",
  "cloud pb rm",
  "cloud frontend deploy",
  "cloud frontend info",
  "cloud frontend rm",
  "cloud backend deploy",
  "cloud backend info",
  "cloud backend rm",
  "cloud logs",
  "cloud env ls",
  "cloud env set",
  "cloud env rm",
  "cloud env import",
];

for (const key of ENV_AWARE) {
  COMMANDS[key].usage += " [--env <name>]";
  COMMANDS[key].flags.push({
    name: "env",
    type: "string",
    required: false,
    description:
      "pbc.json environment to target. Defaults to defaultEnvironment; " +
      "PBC_ENV sets it for a whole shell.",
  });
}
