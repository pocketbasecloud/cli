// Per-command spec, used to render `pb <command> --help` (human) and
// `pb <command> --help --json` / `pb --help --json` (machine-readable).
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
    usage: "pb cloud login",
    summary: "Log in to PocketBase Cloud via browser.",
    args: [],
    flags: [],
  },
  "cloud logout": {
    usage: "pb cloud logout",
    summary: "Log out of PocketBase Cloud.",
    args: [],
    flags: [],
  },
  "cloud whoami": {
    usage: "pb cloud whoami",
    summary: "Show the logged-in PocketBase Cloud account.",
    args: [],
    flags: [],
  },

  // Projects
  "cloud project ls": {
    usage: "pb cloud project ls [--org <id>]",
    summary: "List projects.",
    args: [],
    flags: [{ name: "org", type: "string", required: false }],
  },
  "cloud project create": {
    usage: "pb cloud project create <name>",
    summary: "Create a project.",
    args: [{ name: "name", required: true }],
    flags: [],
  },
  "cloud project use": {
    usage: "pb cloud project use <name|id>",
    summary: "Set the current project.",
    args: [{ name: "name|id", required: true }],
    flags: [],
  },
  "cloud project rm": {
    usage: "pb cloud project rm <name|id> [--yes]",
    summary: "Delete a project.",
    args: [{ name: "name|id", required: true }],
    flags: [],
  },
  "cloud link": {
    usage: "pb cloud link [<pb|frontend|backend>] [<name|id>]",
    summary: "Link one environment of this directory to a cloud resource.",
    details:
      "Records the resource in ./pb.json so deploy, info, rm, logs, and env\n" +
      "need no --name/--id when run here. Never creates or changes the cloud\n" +
      "resource itself.\n\n" +
      "With no arguments, pick from every resource in the project; with a kind\n" +
      "only, pick from that kind.\n\n" +
      "The link belongs to one environment — the file's default, or --env.\n" +
      "Link a second environment to give this directory a second target:\n" +
      "  pb cloud link frontend web-staging --env staging",
    args: [
      { name: "kind", required: false },
      { name: "name|id", required: false },
    ],
    flags: [],
  },
  "cloud unlink": {
    usage: "pb cloud unlink [--all]",
    summary: "Forget one of this directory's environments.",
    details:
      "Clears the environment from ./pb.json only — the cloud resource is left\n" +
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
    usage: "pb cloud environments",
    summary: "List the environments recorded in ./pb.json.",
    details:
      "Shows which cloud resource each environment of this directory deploys\n" +
      "to, and which one a bare deploy targets. Reads the file only — no\n" +
      "login, no network call.\n\n" +
      "Environments are created by deploying or linking with --env:\n" +
      "  pb cloud frontend deploy --env staging --name web-staging",
    args: [],
    flags: [],
  },

  "cloud init": {
    usage: "pb cloud init [pb|frontend|backend] [--force]",
    summary: "Write this directory's build config into pb.json.",
    details:
      `Inspects the directory and records how it should be built and packaged:
the build command, the output directory, the backend runtime, or a
PocketBase project's pb_public / pb_hooks / pb_migrations paths.

Deploy infers the same block when pb.json has none, so this command is
optional — it just lets you see and edit the guess before anything ships.
Nothing in the cloud is touched, and no login is needed.

The kind comes from the argument, or from the directory's existing resource
binding. An existing block is left alone unless --force is passed.`,
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

  // PocketBase instances (cloud-managed)
  "cloud pb deploy": {
    usage:
      "pb cloud pb deploy --name <name> [--location <loc>] [--server <id>] [--skip-env] [--project <id>]",
    summary: "Create or redeploy a PocketBase instance.",
    details:
      `Packages pb_public, pb_hooks, and pb_migrations and ships them with the
new instance. Their locations come from the "build" block in pb.json, which
is inferred from the directory and written there on the first deploy.

The platform reads a PocketBase archive only when the instance is created, so
a redeploy instead pushes pb_hooks/*.pb.js and reports that pb_public and
pb_migrations were left untouched.

A .env beside pb.json is pushed to the instance's env vars by default (merged,
existing cloud-only keys kept). Pass --skip-env to leave them alone, or
--env-file to name a different file.`,
    args: [],
    flags: [
      { name: "name", type: "string", required: true },
      { name: "location", type: "string", required: false },
      { name: "server", type: "string", required: false },
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
        description: "Do not push the .env file to the instance.",
      },
      {
        name: "env-file",
        type: "string",
        required: false,
        description: "Dotenv file to push (default .env).",
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
    usage: "pb cloud pb ls [--project <id>]",
    summary: "List PocketBase instances in a project.",
    args: [],
    flags: [],
  },
  "cloud pb info": {
    usage: "pb cloud pb info (<name>|--name <name>|--id <id>) [--project <id>]",
    summary: "Show PocketBase instance details.",
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
    usage: "pb cloud pb rm (<name>|--name <name>|--id <id>) [--yes]",
    summary: "Delete a PocketBase instance.",
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
    usage: "pb cloud pb hooks push <dir> [--project <id>]",
    summary: "Upload every *.pb.js file in <dir> as a hook.",
    args: [{ name: "dir", required: true }],
    flags: [],
  },
  "cloud pb hooks ls": {
    usage: "pb cloud pb hooks ls [--project <id>]",
    summary: "List uploaded hook files.",
    args: [],
    flags: [],
  },
  "cloud pb hooks rm": {
    usage: "pb cloud pb hooks rm <filename> [--project <id>]",
    summary: "Delete a hook file.",
    args: [{ name: "filename", required: true }],
    flags: [],
  },

  // Frontends
  "cloud frontend deploy": {
    usage:
      "pb cloud frontend deploy --name <name> [--skip-build] [--zip <file>] [--location <loc>]",
    summary: "Build, package, and deploy a static site.",
    details:
      `Runs the build command, zips the output directory, and uploads it. Both
come from the "build" block in pb.json, which is inferred from the directory
(vite/svelte/angular/next config, package.json build script) and written there
on the first deploy.

Frontends have no cloud env store — build-time variables are baked into the
bundle, so --env-file is rejected here.`,
    args: [],
    flags: [
      { name: "name", type: "string", required: true },
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
      { name: "location", type: "string", required: false },
    ],
  },
  "cloud frontend ls": {
    usage: "pb cloud frontend ls [--project <id>]",
    summary: "List frontends.",
    args: [],
    flags: [],
  },
  "cloud frontend info": {
    usage: "pb cloud frontend info (<name>|--name <name>|--id <id>)",
    summary: "Show frontend details.",
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
    usage: "pb cloud frontend rm (<name>|--name <name>|--id <id>) [--yes]",
    summary: "Delete a frontend.",
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
    usage: "pb cloud frontend domain add <domain> --name <site>",
    summary: "Add a custom domain.",
    args: [{ name: "domain", required: true }],
    flags: [{ name: "name", type: "string", required: true }],
  },
  "cloud frontend domain verify": {
    usage: "pb cloud frontend domain verify <domain> --name <site>",
    summary: "Verify a custom domain.",
    args: [{ name: "domain", required: true }],
    flags: [{ name: "name", type: "string", required: true }],
  },
  "cloud frontend domain remove": {
    usage: "pb cloud frontend domain remove <domain> --name <site>",
    summary: "Remove a custom domain.",
    args: [{ name: "domain", required: true }],
    flags: [{ name: "name", type: "string", required: true }],
  },

  // Backends
  "cloud backend deploy": {
    usage:
      "pb cloud backend deploy --name <name> [--runtime <deno|bun|nodejs|nextjs>] [--start <cmd>] [--skip-env] [--zip <file>]",
    summary: "Build, package, and deploy a backend.",
    details:
      `Runs the build command and uploads the result. The runtime, build command,
and output directory come from the "build" block in pb.json, inferred from the
directory (deno.json, bun.lockb, next.config.*, package.json) and written there
on the first deploy.

deno, bun, and nodejs ship their source — the platform installs dependencies on
start, so node_modules is excluded.

nextjs ships a prebuilt bundle: the platform does not run next build (it
exhausts memory on a shared host). Set output: "standalone" in next.config.*,
and the CLI assembles .next/standalone, .next/static, and public into the
layout the runtime expects, defaulting the start command to "node server.js".

A .env beside pb.json is pushed to the backend's env vars by default (merged,
existing cloud-only keys kept). Pass --skip-env to leave them alone, or
--env-file to name a different file.`,
    args: [],
    flags: [
      { name: "name", type: "string", required: true },
      {
        name: "runtime",
        type: "string",
        required: false,
        choices: ["deno", "bun", "nodejs", "nextjs"],
        description: "Defaults to build.runtime in pb.json, else inferred.",
      },
      { name: "start", type: "string", required: false },
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
        description: "Do not push the .env file to the backend.",
      },
      {
        name: "env-file",
        type: "string",
        required: false,
        description: "Dotenv file to push (default .env).",
      },
    ],
  },
  "cloud backend ls": {
    usage: "pb cloud backend ls [--project <id>]",
    summary: "List backends.",
    args: [],
    flags: [],
  },
  "cloud backend info": {
    usage: "pb cloud backend info (<name>|--name <name>|--id <id>)",
    summary: "Show backend details.",
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
    usage: "pb cloud backend rm (<name>|--name <name>|--id <id>) [--yes]",
    summary: "Delete a backend.",
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
    usage: "pb cloud env ls --target pb|backend --name <n>",
    summary: "List environment variables.",
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
    usage: "pb cloud env set KEY=VALUE --target pb|backend --name <n>",
    summary: "Set an environment variable.",
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
    usage: "pb cloud env rm KEY --target pb|backend --name <n>",
    summary: "Remove an environment variable.",
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
    usage: "pb cloud env import <.env> --target pb|backend --name <n>",
    summary: "Bulk-import variables from a .env file.",
    args: [{ name: ".env", required: true }],
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

  // Data
  "cloud data export": {
    usage: "pb cloud data export [--out <file.zip>] [--project <id>]",
    summary: "Export project data.",
    args: [],
    flags: [{ name: "out", type: "string", required: false }],
  },
  "cloud data import": {
    usage: "pb cloud data import <file.zip> [--project <id>]",
    summary: "Import project data.",
    args: [{ name: "file.zip", required: true }],
    flags: [],
  },

  // Logs (cloud)
  "cloud logs": {
    usage: "pb cloud logs <pb|backend> --name <n> [-f] [--project <id>]",
    summary: "Stream logs for a PocketBase instance or backend.",
    args: [{ name: "pb|backend", required: true }],
    flags: [
      { name: "name", type: "string", required: true },
      { name: "follow", type: "boolean", required: false },
    ],
  },

  // Orgs
  "cloud org ls": {
    usage: "pb cloud org ls",
    summary: "List organizations.",
    args: [],
    flags: [],
  },
  "cloud org create": {
    usage: "pb cloud org create <name>",
    summary: "Create an organization.",
    args: [{ name: "name", required: true }],
    flags: [],
  },
  "cloud org rm": {
    usage: "pb cloud org rm <orgId> [--yes]",
    summary: "Delete an organization.",
    args: [{ name: "orgId", required: true }],
    flags: [],
  },
  "cloud org members ls": {
    usage: "pb cloud org members ls <orgId>",
    summary: "List organization members.",
    args: [{ name: "orgId", required: true }],
    flags: [],
  },
  "cloud org members add": {
    usage: "pb cloud org members add <orgId> <email>",
    summary: "Add a member.",
    args: [{ name: "orgId", required: true }, {
      name: "email",
      required: true,
    }],
    flags: [],
  },
  "cloud org members rm": {
    usage: "pb cloud org members rm <orgId> <email>",
    summary: "Remove a member.",
    args: [{ name: "orgId", required: true }, {
      name: "email",
      required: true,
    }],
    flags: [],
  },
  "cloud org share": {
    usage: "pb cloud org share <project> (--org <id>|--none)",
    summary: "Share a project with an org, or unshare it with --none.",
    args: [{ name: "project", required: true }],
    flags: [
      { name: "org", type: "string", required: false },
      { name: "none", type: "boolean", required: false },
    ],
  },

  "cloud upgrade": {
    usage: "pb cloud upgrade",
    summary: "Show the current plan and the upgrade link.",
    args: [],
    flags: [],
  },

  // Instance selection & auth
  "use": {
    usage: "pb use <url> [--name <profile>]",
    summary: "Select a PocketBase instance.",
    args: [{ name: "url", required: true }],
    flags: [{ name: "name", type: "string", required: false }],
  },
  "login": {
    usage: "pb login [--email <e>] [--password <p>] [--profile <name>]",
    summary: "Log in as the instance superuser.",
    args: [],
    flags: [
      { name: "email", type: "string", required: false },
      { name: "password", type: "string", required: false },
    ],
  },
  "logout": {
    usage: "pb logout [--remove] [--profile <name>]",
    summary:
      "Log out of the current instance profile. --remove also forgets it.",
    args: [],
    flags: [{ name: "remove", type: "boolean", required: false }],
  },
  "whoami": {
    usage: "pb whoami [--profile <name>]",
    summary: "Show the active instance profile.",
    args: [],
    flags: [],
  },

  // Collections
  "collections ls": {
    usage: "pb collections ls",
    summary: "List collections.",
    args: [],
    flags: [],
  },
  "collections get": {
    usage: "pb collections get <idOrName>",
    summary: "Show a collection.",
    args: [{ name: "idOrName", required: true }],
    flags: [],
  },
  "collections create": {
    usage: "pb collections create <name> [--type base|auth|view]",
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
    usage: "pb collections update <idOrName> '<json>'",
    summary: "Update a collection.",
    args: [{ name: "idOrName", required: true }, {
      name: "json",
      required: true,
    }],
    flags: [],
  },
  "collections rm": {
    usage: "pb collections rm <idOrName> [--yes]",
    summary: "Delete a collection.",
    args: [{ name: "idOrName", required: true }],
    flags: [],
  },
  "collections export": {
    usage: "pb collections export [--out <file>]",
    summary: "Export all collections to JSON.",
    args: [],
    flags: [{ name: "out", type: "string", required: false }],
  },
  "collections import": {
    usage: "pb collections import <file.json> [--delete-missing]",
    summary:
      "Import collections from JSON. --delete-missing drops collections not in the file.",
    args: [{ name: "file.json", required: true }],
    flags: [{ name: "delete-missing", type: "boolean", required: false }],
  },

  // Records
  "records ls": {
    usage:
      "pb records ls <collection> [--filter <expr>] [--sort <expr>] [--page <n>] [--per-page <n>]",
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
    usage: "pb records get <collection> <id>",
    summary: "Show a record.",
    args: [{ name: "collection", required: true }, {
      name: "id",
      required: true,
    }],
    flags: [],
  },
  "records create": {
    usage: "pb records create <collection> '<json>'",
    summary: "Create a record.",
    args: [{ name: "collection", required: true }, {
      name: "json",
      required: true,
    }],
    flags: [],
  },
  "records update": {
    usage: "pb records update <collection> <id> '<json>'",
    summary: "Update a record.",
    args: [
      { name: "collection", required: true },
      { name: "id", required: true },
      { name: "json", required: true },
    ],
    flags: [],
  },
  "records rm": {
    usage: "pb records rm <collection> <id> [--yes]",
    summary: "Delete a record.",
    args: [{ name: "collection", required: true }, {
      name: "id",
      required: true,
    }],
    flags: [],
  },

  // Rules
  "rules get": {
    usage: "pb rules get <collection>",
    summary: "Show API rules.",
    args: [{ name: "collection", required: true }],
    flags: [],
  },
  "rules set": {
    usage:
      "pb rules set <collection> [--list-rule <expr>] [--view-rule <expr>] " +
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
    usage: "pb auth <collection> config [--set '<field>=<json>']",
    summary: "View or edit an auth collection's auth-related settings.",
    details:
      "Without --set, prints the current value of: authRule, manageRule, authAlert,\n" +
      "oauth2, passwordAuth, mfa, otp, verificationTemplate, resetPasswordTemplate.\n\n" +
      "With --set '<field>=<json>', replaces that one field's value entirely — run\n" +
      "without --set first if the field (e.g. oauth2.providers) already has content\n" +
      "you need to keep, and include it in the json you send.\n\n" +
      "Examples:\n" +
      "  pb auth users config\n" +
      '  pb auth users config --set \'passwordAuth={"enabled":true,"identityFields":["email"]}\'\n\n' +
      '  Enable Google sign-in on the "users" collection (get clientId/clientSecret\n' +
      "  from a Google Cloud OAuth 2.0 Client ID, with authorized redirect URI\n" +
      "  <your-instance-url>/api/oauth2-redirect):\n" +
      '    pb auth users config --set \'oauth2={"enabled":true,"providers":' +
      '[{"name":"google","clientId":"<GOOGLE_CLIENT_ID>.apps.googleusercontent.com",' +
      '"clientSecret":"<GOOGLE_CLIENT_SECRET>"}]}' + "'\n\n" +
      "  Add Google alongside an existing provider — include every provider you\n" +
      "  want to keep, since the json replaces the whole oauth2 field:\n" +
      '    pb auth users config --set \'oauth2={"enabled":true,"providers":' +
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
    usage: "pb settings get",
    summary: "Show all instance settings.",
    args: [],
    flags: [],
  },
  "settings mail": {
    usage: "pb settings mail",
    summary: "Show SMTP settings.",
    args: [],
    flags: [],
  },
  "settings mail set": {
    usage: "pb settings mail set '<json>'",
    summary: "Update SMTP settings.",
    args: [{ name: "json", required: true }],
    flags: [],
  },
  "settings mail test": {
    usage: "pb settings mail test <email>",
    summary: "Send a test email.",
    args: [{ name: "email", required: true }],
    flags: [],
  },
  "settings s3": {
    usage: "pb settings s3",
    summary: "Show S3 storage settings.",
    args: [],
    flags: [],
  },
  "settings s3 set": {
    usage: "pb settings s3 set '<json>'",
    summary: "Update S3 storage settings.",
    args: [{ name: "json", required: true }],
    flags: [],
  },
  "settings s3 test": {
    usage: "pb settings s3 test",
    summary: "Test the S3 connection.",
    args: [],
    flags: [],
  },
  "settings backup ls": {
    usage: "pb settings backup ls",
    summary: "List backups.",
    args: [],
    flags: [],
  },
  "settings backup create": {
    usage: "pb settings backup create [<name>]",
    summary: "Create a backup.",
    args: [{ name: "name", required: false }],
    flags: [],
  },
  "settings backup rm": {
    usage: "pb settings backup rm <key> [--yes]",
    summary: "Delete a backup.",
    args: [{ name: "key", required: true }],
    flags: [],
  },
  "settings backup download": {
    usage: "pb settings backup download <key> [--out <file>]",
    summary: "Download a backup.",
    args: [{ name: "key", required: true }],
    flags: [{ name: "out", type: "string", required: false }],
  },

  // Cron
  "cron ls": {
    usage: "pb cron ls",
    summary: "List cron jobs.",
    args: [],
    flags: [],
  },
  "cron run": {
    usage: "pb cron run <jobId>",
    summary: "Run a cron job now.",
    args: [{ name: "jobId", required: true }],
    flags: [],
  },

  // Local PocketBase binary
  "init": {
    usage: "pb init [<version>] [--dir <d>] [--force]",
    summary: "Download a PocketBase binary and scaffold a local project.",
    details:
      "Downloads the binary for this OS and CPU, then creates pb_hooks/,\n" +
      "pb_migrations/, a README.md, .gitignore entries (which exclude the\n" +
      "binary and pb_data/), and a pocketbaseVersion pin in pb.json. Existing\n" +
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
      "pb install [<version>] [--dir <d>] [--force] [--os <o>] [--arch <a>]",
    summary: "Download a PocketBase binary and record the version pin.",
    details:
      "Like `pb init` without the scaffolding. --os/--arch override platform\n" +
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
    usage: "pb versions [--all] [--pre] [--json]",
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
    usage: "pb which [--dir <d>]",
    summary: "Show the installed PocketBase binary and its pinned version.",
    args: [],
    flags: [{ name: "dir", type: "string", required: false }],
  },

  // Instance logs
  "logs": {
    usage: "pb logs [--filter <expr>] [--page <n>] [--per-page <n>] [-f]",
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
 * Every command that resolves a cloud resource through pb.json, and so picks
 * one of its environments. Listed once and applied below rather than repeated
 * in fifteen flag arrays, which is how one of them ends up out of step.
 */
const ENV_AWARE = [
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
      "pb.json environment to target. Defaults to defaultEnvironment; " +
      "PB_ENV sets it for a whole shell.",
  });
}
