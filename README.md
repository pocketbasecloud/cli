# @pocketbasecloud/cli

The `pb` command-line tool for working with **any** PocketBase instance,
local/remote - and [PocketBase Cloud](https://pocketbasecloud.com), from your
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

### Staying up to date

```sh
pb upgrade --check   # what's installed vs what's published
pb upgrade           # update in place
```

`pb upgrade` downloads the release archive for your OS and CPU, verifies its
SHA-256 against the release's `checksums.txt`, and replaces the running binary —
nothing is changed unless the checksum matches. Pass a version to install a
specific release, including an older one to roll back:

```sh
pb upgrade 0.2.1
```

Only a standalone binary (the `curl | sh` installer above, or a release archive)
can be replaced in place. An npm install has to be updated with npm, and a
from-source install by updating its clone; in both cases `pb upgrade` prints the
exact command and exits non-zero rather than pretending to succeed.

> `pb upgrade` updates the CLI. To change your **plan**, use `pb cloud upgrade`.

### From source (Deno)

For platforms without a prebuilt binary. Install from a clone, pointing `-c` at
the repo's `deno.json` — `deno install -g` otherwise runs the entry point with
`--no-config`, and the import map it holds would not resolve:

```sh
git clone https://github.com/pocketbasecloud/cli
cd cli
deno install -g -A -c deno.json -n pb ./main.ts
```

The shim refers to the clone by absolute path, so keep it where it is.

## Quick start

**Local development:**

```sh
pb init            # download PocketBase + scaffold a project here
./pocketbase serve # start it locally
```

**Deploy to PocketBase Cloud:**

```sh
pb cloud login                   # authenticate via browser
pb cloud project create my-app   # create a project
pb cloud project use my-app      # make it the current one
pb cloud pb deploy               # deploy a PocketBase instance
pb cloud logs pb                 # stream its logs
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
pb cloud frontend info       # no flags — describes it
pb cloud unlink              # detach (the cloud resource is untouched)
```

(`logs` still takes its kind — `pb cloud logs pb` or `pb cloud logs backend` —
because it is one command over two resource types. Frontends are static files
and have no logs.)

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

A build only works once its dependencies are there, so deploy installs them
first when something `package.json` declares is not installed — `pnpm install`,
`yarn install`, `bun install`, or `npm install`, whichever the lockfile names,
run at the workspace root when the project is part of one. A fresh clone, a CI
runner with no cache, or a dependency you added but never installed therefore
deploys instead of failing on `next: not found`. Nothing runs when the tree is
already installed; set `install` in the build block to run your own command, or
`""` to turn the step off.

Edit that block whenever the guess is wrong; it is never overwritten. Useful
extras: `exclude` (globs dropped from the zip) and `envFile` (which dotenv file
to push). `.git`, `pb_data`, `.DS_Store`, `.env`, `.env.*`, and `*.log` are
always excluded, and so is `node_modules` — except in a Next.js standalone
bundle, which needs the pruned copy Next produces. An environment can override
any of these — see [Environments](#environments).

Handy flags: `--skip-build` packages without rebuilding, and `--zip <file>`
uploads an archive you built yourself.

### What a deploy shows you

Every wait a deploy contains — installing, building, packaging, uploading the
archive, provisioning, waiting for the domain to answer — is a step that names
itself, spins while it runs, and closes with how long it took:

```
✓ Installed dependencies (npm install) 11s
✓ Built (npm run build) 24s
✓ Packaged 412 file(s), 18.4 MB. 2s
✓ Uploaded code.zip (18.4 MB) 9s
✓ api is running 41s
✓ Reachable. 37s
```

The animation belongs to the terminal: piped into a file or a CI log the same
steps print as plain lines (`→` when a step starts, `✓`/`✗` when it ends,
including each provisioning status as it changes), and `--json` prints nothing
but the final JSON object on stdout.

### Backends

The runtime decides what ships. `deno`, `bun`, and `nodejs` upload their source
— the platform installs dependencies on start.

`nextjs` is different: the platform does **not** run `next build` (it exhausts
memory on a shared host), so you ship a prebuilt bundle. That bundle exists only
when the build asks for it, so **deploy adds `output: "standalone"` to
`next.config.*` for you** — before the build, so you never lose one to a config
you had no reason to write, and it prints the change. It writes a
`next.config.js` if the project has none, and leaves a config that already sets
`output` alone. The CLI then assembles `.next/standalone`, `.next/static`, and
`public` into the layout the runtime expects, starting it with
`node server.js`.

A config setting `output: "export"` is refused rather than rewritten: that is a
static site, so deploy it with `pb cloud frontend deploy`.

```jsonc
// api/pb.json
{
  "build": { "command": "npm run build", "runtime": "nextjs" }
}
```

Backends run on Pro compute, and creating one picks which. The compute is the
**project owner's**, not yours: in a project shared with an organization, a
developer on any plan deploys onto the owner's compute and against the owner's
Pro plan. One compute is used without asking, several are offered as a menu, and
`--compute <id>` settles it outright — which is what CI wants, since
`--no-input` and `--json` will not choose for you. Redeploying never moves a
backend to another compute.

The same applies to `pb cloud pb deploy` and `pb cloud frontend deploy`: they
pick a compute whenever there is one to pick — on Pro, and in a project shared
with an organization. On the free and starter plans the platform places the
deploy in its shared pool by capacity, so `--compute` is unnecessary there.
`pb cloud compute ls` lists the ids the flag accepts. (`--server` is the flag's
former name and still works.)

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
reads that archive only at creation, so a later `pb cloud pb deploy` pushes the
`.js` and `.json` files in `pb_hooks/` instead and tells you that `pb_public`
and `pb_migrations` were left as they are.

PocketBase only runs `*.pb.js`, but the plain `.js` and `.json` files beside
them go up as well — a hook that `require()`s a helper module or a data file
needs it on the instance too. Hooks are stored as flat files, so a
subdirectory of `pb_hooks/` is not uploaded and the deploy names the ones it
skipped. A push carries at most **10** files — more than that is nearly always
the wrong directory, so `pb` stops rather than uploading it.

### Environment variables

**Nothing is pushed unless you name the file**, and each environment names its
own — a `.env` holding localhost URLs and test keys has no business in
production. The first deploy of an environment asks once and records the answer
in `pb.json`:

```sh
$ pb cloud pb deploy --env prod

No env file configured for environment "prod".
  1) Don't push env vars
  2) .env.prod
  3) .env
  4) Enter a path…
> 2
```

```jsonc
// pb.json — the answer, and one per environment
"environments": {
  "prod":    { "id": "…", "name": "api",     "build": { "envFile": ".env.prod" } },
  "staging": { "id": "…", "name": "api-stg", "build": { "envFile": ".env.staging" } },
  "dev":     { "id": "…", "name": "api-dev", "build": { "envFile": "" } }
}
```

`""` means "no env file for this environment" — a recorded answer, so the
question is never asked again. Edit `pb.json` to change any of them.

```sh
pb cloud backend deploy                        # pushes what pb.json configures
pb cloud backend deploy --env-file .env.prod   # names it outright
pb cloud backend deploy --skip-env             # pushes nothing this run
pb cloud backend deploy --delete-missing       # the file is the whole truth
```

`--env-file` is also recorded, but only for an environment that has no `envFile`
yet — a deploy never overwrites a choice already in the file. Keys in the file
are written and cloud-only keys left alone (unless `--delete-missing`); a file
named but not found fails the deploy before anything is provisioned. Values are
never printed, and dotenv files never go into the zip.

Under `--no-input` or `--json` nothing is asked, nothing is pushed unless
configured, and `pb.json` is never written — so CI names its file explicitly.

Frontends have no cloud env store — their variables are baked in at build time.

## Common tasks

### Ship a full-stack app

One directory per resource, each linked once. They can all live in the same repo
and the same cloud project:

```sh
pb cloud login
pb cloud project create my-app
pb cloud project use my-app

cd db  && pb cloud pb deploy --name my-app-db        # PocketBase + hooks + migrations
cd ../api && pb cloud backend deploy --name my-app-api  # Pro plan only
cd ../web && pb cloud frontend deploy --name my-app-web
```

Each deploy prints what it packaged, records the binding in that directory's
`pb.json`, and asks once which dotenv file this environment uses. From then on a bare
`pb cloud <kind> deploy` in the same directory redeploys it.

### Promote staging to production

```sh
cd web
pb cloud frontend deploy --name web-staging --env staging  # first deploy creates + links
pb cloud environments                                      # show what this directory targets
pb cloud frontend deploy --name web --env production       # --name: production isn't linked yet
pb cloud frontend deploy --env production                  # from now on, no flags
```

### Update a running instance

A redeploy ships the same directories as the first deploy. Hooks go through the
hooks route (which keeps the portal's editor in sync); `pb_migrations` and
`pb_public` travel in the archive, which the platform installs on the running
instance — migrations merged with the ones already there, `pb_public` replaced
wholesale, and new migrations applied by the restart that follows:

```sh
cd db
pb cloud pb deploy            # hooks + pb_migrations + pb_public
pb cloud pb hooks ls          # what the instance has
pb cloud pb hooks rm old.pb.js
```

### Work with data on a deployed instance

`pb use` points the instance commands at any PocketBase, cloud-hosted or not:

```sh
pb cloud pb info --name my-app-db          # URL + generated superuser login
pb use https://<id>.<key>.pocketbasecloud.com
pb login                                    # superuser

pb collections create '{"name":"tasks","fields":[
  {"name":"title","type":"text","required":true},
  {"name":"done","type":"bool"}]}'
pb records create tasks '{"title":"first"}'
pb rules set tasks --list-rule '@request.auth.id != ""'
```

### Back up, export, restore

```sh
pb settings backup create              # snapshot on the instance
pb settings backup ls
pb settings backup download <key> --out backup.zip
pb cloud data export --name my-app-db --out data.zip   # via the platform
```

### Manage environment variables

```sh
pb cloud env ls --target backend --name my-app-api
pb cloud env set API_KEY=secret --target backend --name my-app-api
pb cloud env import .env.production --target backend --name my-app-api
pb cloud env import .env.production --target backend --name my-app-api \
  --delete-missing                 # the file is the whole truth
```

Names only are listed — the platform stores values encrypted and never returns
them in plaintext.

An import merges by default: keys in the file are written, keys only in the
cloud are left alone. `--delete-missing` removes those cloud-only keys instead,
so the instance ends up with exactly what the file lists. The same flag works on
`pb cloud pb deploy` and `pb cloud backend deploy`, which push the environment's
configured dotenv file as part of a deploy.

### Diagnose a deploy that went wrong

```sh
pb cloud pb ls                       # statuses at a glance
pb cloud pb info --name my-app-db    # status, URL, compute, admin login
pb cloud logs backend --name my-app-api -f   # follow container logs
```

If a deploy times out, the resource was still created — the error names the
`info` and `rm` commands for it.

A newly created domain needs DNS and a certificate before it answers, even once
the status reads `running`, so the first deploy of a PocketBase, backend, or
frontend prints its URL and then waits for it to respond. Giving up on that wait
is not a failure — the resource is running, and the exit code stays `0`. Under
`--json` the deploy waits just the same and reports the outcome as `reachable`.

### Share a project with a team

```sh
pb cloud org create acme
pb cloud org share my-app --org <orgId>
pb cloud org members add <orgId> teammate@example.com
pb cloud org share my-app --none          # stop sharing
```

Everyone in the organization deploys against the **owner's** plan and onto the
owner's compute, so a member on the free plan can deploy backends into a shared
project whose owner is on Pro — and give them custom domains. Deleting a
resource stays with its owner.

### Run in CI (no browser, no prompts)

Authenticate with a token instead of `pb cloud login`, and make every command
fail rather than ask:

```sh
export PB_TOKEN=…            # a PocketBase Cloud user token

pb cloud whoami --json                       # preflight
pb cloud frontend deploy --no-input --json   # never prompts; JSON on stdout
```

`PB_TOKEN` is all a CI job sets: the CLI always talks to PocketBase Cloud's own
hosts.

`--json` prints machine-readable output on stdout and keeps build output on
stderr, so `pb … --json | jq` is safe. Errors are `{"error":"…"}` on stderr with
a non-zero exit: `2` usage, `3` not permitted (plan or slot limits), `4` not
authenticated, `5` timed out, `6` the resource finished in a failed state, `7`
your build command failed.

### Pin a PocketBase version

Deploys use the newest published release unless told otherwise. Pin one to keep
cloud and local identical:

```sh
pb install 0.39.9                       # local binary + records the pin in pb.json
pb cloud pb deploy --pb-version 0.39.9  # or set it per deploy
```

### Keep `pb` itself current

`pb` checks for a newer release of itself at most once a day and, when there is
one, prints a single line on stderr after the command it was already running:

```
Update available: pb 0.2.3 → 0.2.4. Run `pb upgrade`.
```

The command it suggests matches how this copy was installed. The check is
skipped under `--json`, when `CI` is set, and when output is redirected — so it
never lands in a pipe or a log. `PB_NO_UPDATE_CHECK=1` turns it off entirely,
and `pb upgrade --check` asks on demand.

## What you can do

Run `pb --help`, or `pb <command> --help` for details on any command.

- **Local** — `init`, `install`, `versions`, `which`: manage a pinned PocketBase
  binary and scaffold projects. `upgrade` updates `pb` itself.
- **Instance** (`pb use <url>`) — `collections`, `records`, `rules`, `auth`,
  `settings` (incl. `mail`/`s3`/`backup`), `cron`, `logs`: operate any
  PocketBase instance.
- **Cloud** (`pb cloud ...`) — `login`, `whoami`, `init`, `link`/`unlink`,
  `environments`, `project`, `pb`, `backend`, `frontend`, `env`, `logs`, `org`,
  `compute ls`, `data export`, `upgrade`, custom domains: manage your PocketBase
  Cloud account and deployments. (`data import` is not implemented — the
  platform's import needs a target collection and a field mapping, so use the
  portal's import dialog.)

## Supported platforms

macOS (arm64, x64), Linux (arm64, x64), and Windows (x64; Windows-on-ARM runs
the x64 build under emulation). On any other platform, install via Deno from
source (above).

## Links

- PocketBase Cloud: https://pocketbasecloud.com
- Issues & releases: https://github.com/pocketbasecloud/cli

## License

MIT
