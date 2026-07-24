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
    usage: "pb cloud link [<name|id>] [--no-input]",
    summary: "Link this directory to a project.",
    args: [{ name: "name|id", required: false }],
    flags: [],
  },

  // PocketBase instances (cloud-managed)
  "cloud pb deploy": {
    usage:
      "pb cloud pb deploy --name <name> [--location <loc>] [--server <id>] [--project <id>]",
    summary: "Create or redeploy a PocketBase instance.",
    args: [],
    flags: [
      { name: "name", type: "string", required: true },
      { name: "location", type: "string", required: false },
      { name: "server", type: "string", required: false },
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
      "pb cloud frontend deploy --name <name> [--zip <file>] [--location <loc>]",
    summary: "Create or redeploy a static site.",
    args: [],
    flags: [
      { name: "name", type: "string", required: true },
      { name: "zip", type: "string", required: false },
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
      "pb cloud backend deploy --name <name> --runtime <deno|bun|nodejs> [--start <cmd>] [--zip <file>]",
    summary: "Create or redeploy a backend.",
    args: [],
    flags: [
      { name: "name", type: "string", required: true },
      {
        name: "runtime",
        type: "string",
        required: true,
        choices: ["deno", "bun", "nodejs"],
      },
      { name: "start", type: "string", required: false },
      { name: "zip", type: "string", required: false },
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
