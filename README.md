# @pocketbasecloud/cli

The `pb` command-line tool for [PocketBase Cloud](https://pocketbasecloud.com) —
and for working with **any** PocketBase instance, local or remote, from your
terminal.

One binary takes a project from `pb init` on your laptop to a deployed instance
in the cloud, and manages everything in between: collections, records, API
rules, backups, hooks, and deployments.

## Why `pb`

- **Full lifecycle, one tool.** Scaffold and run PocketBase locally, then deploy
  PocketBase instances, backends, and static sites to the cloud — without
  leaving the shell.
- **Works with any instance, not just the cloud.** Point `pb` at any PocketBase
  URL with `pb use <url>` to manage collections, records, rules, settings,
  SMTP/S3, cron jobs, and backups.
- **Native, self-contained binary.** Compiled ahead of time — no runtime to
  install when you use the `curl | sh` installer, and a fast cold start.
- **Built for scripting and CI.** `--json` for machine-readable output, `--yes`
  to skip confirmations, and `--no-input` to fail instead of prompting.
- **Version-pinned local dev.** `pb init` / `pb install` download a specific
  PocketBase build and record the pin, so your team runs the same version.

## Install

Pick whichever fits your setup — the npm and `curl | sh` channels are fully
independent (a GitHub outage can't break an npm install, and vice-versa).

### npm (global)

```sh
npm i -g @pocketbasecloud/cli
pb --help
```

npm downloads only the ~28 MB binary for your platform (via
`optionalDependencies`), not all of them.

### npx (no install)

```sh
npx @pocketbasecloud/cli --help
```

### curl \| sh (macOS/Linux, no Node required)

```sh
curl -fsSL https://raw.githubusercontent.com/pocketbasecloud/cli/main/scripts/install.sh | sh
```

Downloads the binary from the latest GitHub Release, verifies its SHA-256, and
installs to `/usr/local/bin` (or `~/.local/bin`). Override the location with
`PB_INSTALL_DIR`.

### From source (Deno)

For platforms without a prebuilt binary. Clone the repo so `deno.json` (the
import map) resolves, then install from the local path:

```sh
git clone https://github.com/pocketbasecloud/cli
deno install -A -n pb ./cli/main.ts
```

## Quick start

**Local development:**

```sh
pb init            # download PocketBase + scaffold a project here
./pocketbase serve # start it locally
```

**Deploy to PocketBase Cloud:**

```sh
pb cloud login              # authenticate via browser
pb cloud project create     # create a project
pb cloud pb deploy          # deploy a PocketBase instance
pb cloud logs               # stream its logs
```

**Manage any running instance:**

```sh
pb use https://my-instance.example.com   # select an instance
pb login                                 # log in as superuser
pb collections ls                        # list collections
pb records ls posts                      # list records
pb settings backup create                # back it up
```

## Linking local ↔ cloud

Give each PocketBase, frontend, or backend its own directory, and link that
directory to its cloud resource once. Afterwards `deploy`, `info`, `rm`, `logs`,
and `env` run there with no `--name`/`--id`:

```sh
cd frontend
pb cloud link frontend web   # bind ./ to the frontend named "web"
pb cloud frontend deploy     # no flags — redeploys the bound frontend
pb cloud logs                # no flags — tails it
pb cloud unlink              # detach (the cloud resource is untouched)
```

`pb cloud link` never creates or changes anything in the cloud — it only writes
the binding. Run it with no arguments to pick from every resource in the
project, or with a kind (`pb`, `frontend`, `backend`) to narrow the list:

```sh
pb cloud link                # pick from all resources
pb cloud link frontend       # pick from frontends only
```

Deploying also records the binding, so the first deploy of a new resource links
the directory too, and `pb cloud frontend rm` clears it.

The binding lives in `pb.json`. Each file carries its own `projectId`, so
directories stay independent — and every `pb cloud …` command run under one
resolves to that project automatically (the file is found by walking up parent
directories):

```jsonc
// frontend/pb.json
{
  "projectId": "dhs4xnprgplurvo",
  "kind": "frontends",
  "defaultEnvironment": "production",
  "environments": {
    "production": { "id": "…", "name": "web" }
  }
}
```

To set a default project for directories that aren't linked, use
`pb cloud project use <name|id>`.

### Environments

One directory can deploy to several environments — staging and production, say.
Each is its own cloud resource in the **same** project; everything they share
(the project, the kind, the build) is written once, and each environment lists
only what differs:

```jsonc
// frontend/pb.json
{
  "projectId": "dhs4xnprgplurvo",
  "kind": "frontends",
  "build": { "command": "npm run build", "outputDir": "dist" },
  "defaultEnvironment": "production",
  "environments": {
    "production": { "id": "…", "name": "web" },
    "staging": {
      "id": "…",
      "name": "web-staging",
      "build": { "command": "npm run build:staging" }
    }
  }
}
```

Pick one with `--env`; without it, commands use `defaultEnvironment`:

```sh
pb cloud frontend deploy                             # production
pb cloud frontend deploy --env staging               # staging
pb cloud frontend deploy --env staging --name web-staging   # create it
PB_ENV=staging pb cloud frontend deploy              # for a whole shell (CI)
```

A `--env` naming an environment the file does not have is an error everywhere
except `deploy`, which creates it — and, like a first deploy, wants a `--name`
to create it under. `pb cloud link … --env staging` binds an environment to a
resource that already exists.

`--env` works the same way on `info`, `rm`, `logs`, and `env`, so
`pb cloud env set API_KEY=… --target backend --env staging` writes to staging
only. `pb cloud environments` lists what the file records, and
`pb cloud unlink --env staging` forgets one (`--all` forgets them all).

## Building and deploying

`deploy` builds the project, packages the right files, and uploads them:

```sh
cd web
pb cloud frontend deploy --name web   # runs the build, zips it, ships it
```

How to build and what to package lives in a `build` block in `pb.json`. You
never have to write it — the first deploy infers it from the directory, prints
what it found, and records it. Run `pb cloud init` to do that step on its own
and review the guess before anything ships:

```jsonc
// web/pb.json
{
  "projectId": "dhs4xnprgplurvo",
  "kind": "frontends",
  "defaultEnvironment": "production",
  "environments": {
    "production": { "id": "…", "name": "web" }
  },
  "build": {
    "command": "npm run build",
    "outputDir": "dist"
  }
}
```

Edit that block whenever the guess is wrong; it is never overwritten. Useful
extras: `exclude` (globs dropped from the zip) and `envFile` (which dotenv file
to push). `.git`, `pb_data`, `node_modules`, `.env*`, and `*.log` are always
excluded. An environment can override any of these — see
[Environments](#environments).

Handy flags: `--skip-build` packages without rebuilding, and `--zip <file>`
uploads an archive you built yourself.

### Backends

The runtime decides what ships. `deno`, `bun`, and `nodejs` upload their source
— the platform installs dependencies on start.

`nextjs` is different: the platform does **not** run `next build` (it exhausts
memory on a shared host), so you ship a prebuilt bundle. Set
`output: "standalone"` in `next.config.*` and the CLI assembles
`.next/standalone`, `.next/static`, and `public` into the layout the runtime
expects, starting it with `node server.js`.

```jsonc
// api/pb.json
{
  "build": { "command": "npm run build", "runtime": "nextjs" }
}
```

### PocketBase

`pb.json` records where the three PocketBase directories live, so they can sit
anywhere:

```jsonc
// db/pb.json
{
  "build": {
    "pbPublic": "pb_public",
    "pbHooks": "pb_hooks",
    "pbMigrations": "pb_migrations"
  }
}
```

They are packaged and shipped when the instance is **created**. The platform
reads that archive only at creation, so a later `pb cloud pb deploy` pushes
`pb_hooks/*.pb.js` instead and tells you that `pb_public` and `pb_migrations`
were left as they are.

### Environment variables

A `.env` next to `pb.json` is pushed to the PocketBase or backend it belongs to
on every deploy. Keys in the file are written; keys that exist only in the cloud
are left alone. Values are never printed, and the file itself never goes into
the zip.

```sh
pb cloud backend deploy                      # pushes .env
pb cloud backend deploy --skip-env           # leaves cloud env vars alone
pb cloud backend deploy --env-file .env.prod # pushes a different file
```

Frontends have no cloud env store — their variables are baked in at build time.

## What you can do

Run `pb --help`, or `pb <command> --help` for details on any command.

- **Local** — `init`, `install`, `versions`, `which`: manage a pinned PocketBase
  binary and scaffold projects.
- **Instance** (`pb use <url>`) — `collections`, `records`, `rules`, `auth`,
  `settings` (incl. `mail`/`s3`/`backup`), `cron`, `logs`: operate any
  PocketBase instance.
- **Cloud** (`pb cloud ...`) — `init`, `project`, `pb`, `backend`, `frontend`,
  `env`, `logs`, `org`, `data` import/export, custom domains: manage your
  PocketBase Cloud account and deployments.

## Supported platforms

macOS (arm64, x64), Linux (arm64, x64), and Windows (x64; Windows-on-ARM runs
the x64 build under emulation). On any other platform, install via Deno from
source (above).

## Links

- PocketBase Cloud: https://pocketbasecloud.com
- Issues & releases: https://github.com/pocketbasecloud/cli

## License

MIT
