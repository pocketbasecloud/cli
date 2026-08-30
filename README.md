# @pocketbasecloud/cli

The `pbc` command-line tool for working with **any** PocketBase instance,
local/remote - and [PocketBase Cloud](https://pocketbasecloud.com), from your
terminal.

One binary takes a project from `pbc local init` on your laptop to a deployed
instance in the cloud, and manages everything in between: collections, records,
API rules, backups, hooks, and deployments.

> **Renamed in 0.6.0: `pb` is now `pbc`** — the command, the project file
> (`pb.json` → `pbc.json`), the variables (`PB_TOKEN` → `PBC_TOKEN`, and so on
> for every `PB_*`), and the saved login (`~/.config/pb/` → `~/.config/pbc/`).
>
> **Every old name still works, so nothing you already wrote has to change.**
> `pb` is installed beside `pbc` and runs the same binary. A directory holding a
> `pb.json` is read from it and written back to it, so a committed repository
> never grows a second file. A `PB_*` variable is read when its `PBC_*` twin is
> unset. The old config is read until the first save, which writes the new one
> and leaves the old where it is. The one thing to do by hand is a repository
> secret: new workflows read `secrets.PBC_TOKEN`.

> **Renamed in 0.8.0: the command names moved onto their roots.** `pbc cloud pb
> …` is now `pbc pocketbase …`, `pbc cloud upgrade` is `pbc plan`, `pbc cloud
> init` is `pbc init`, `pbc cloud logs` is `pbc logs`, `pbc cloud ci init` is
> `pbc ci init`, and `pbc init|install|versions|which|upgrade` are
> `pbc local init|install|versions|which` / `pbc self upgrade`. Nothing is left
> under `pbc cloud`. Every old name still works — the CLI prints the new one
> once on stderr, then runs the command.

## Why `pbc`

- **Full lifecycle, one tool.** Scaffold and run PocketBase locally, then deploy
  PocketBase instances, backends, and static sites to the cloud — without
  leaving the shell.
- **Works with any instance, not just the cloud.** Point `pbc` at any PocketBase
  URL with `pbc admin use <url>` to manage collections, records, rules,
  settings, SMTP/S3, cron jobs, and backups.
- **Native, self-contained binary.** Compiled ahead of time — no runtime to
  install when you use the `curl | sh` installer, and a fast cold start.
- **Built for scripting and CI.** `--json` for machine-readable output, `--yes`
  to skip confirmations, and `--no-input` to fail instead of prompting.
- **Version-pinned local dev.** `pbc local init` / `pbc local install` download a specific
  PocketBase build and record the pin, so your team runs the same version.

## Install

Pick whichever fits your setup — the npm and `curl | sh` channels are fully
independent (a GitHub outage can't break an npm install, and vice-versa).

### npm (global)

```sh
npm i -g @pocketbasecloud/cli
pbc --help
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
installs to `/usr/local/bin` (or `~/.local/bin`), with `pb` linked beside it.
Override the location with `PBC_INSTALL_DIR`.

### Staying up to date

```sh
pbc self upgrade --check   # what's installed vs what's published
pbc self upgrade           # update in place
```

`pbc self upgrade` downloads the release archive for your OS and CPU, verifies its
SHA-256 against the release's `checksums.txt`, and replaces the running binary —
nothing is changed unless the checksum matches. Pass a version to install a
specific release, including an older one to roll back:

```sh
pbc self upgrade 0.2.1
```

Only a standalone binary (the `curl | sh` installer above, or a release archive)
can be replaced in place. An npm install has to be updated with npm, and a
from-source install by updating its clone; in both cases `pbc self upgrade` prints the
exact command and exits non-zero rather than pretending to succeed.

> `pbc self upgrade` updates the CLI. To change your **plan**, use `pbc plan`.

### From source (Deno)

For platforms without a prebuilt binary. Install from a clone, pointing `-c` at
the repo's `deno.json` — `deno install -g` otherwise runs the entry point with
`--no-config`, and the import map it holds would not resolve:

```sh
git clone https://github.com/pocketbasecloud/cli
cd cli
deno install -g -A -c deno.json -n pbc ./main.ts
```

The shim refers to the clone by absolute path, so keep it where it is.

## Quick start

**Local development:**

```sh
pbc local init      # download PocketBase + scaffold a project here
./pocketbase serve  # start it locally
```

**Deploy to PocketBase Cloud:**

```sh
pbc login                     # authenticate via browser
pbc project create my-app     # create a project
pbc project use my-app        # make it the current one
pbc deploy                    # detect what's in this directory, deploy it
pbc logs pocketbase     # stream its logs
```

**Manage any running instance:**

```sh
pbc admin use https://my-instance.example.com   # select an instance
pbc admin login                                # log in as superuser
pbc admin collections ls                       # list collections
pbc admin records ls posts                     # list records
pbc admin settings backup create               # back it up
```

## Binding a directory to a cloud resource

Give each PocketBase, frontend, or backend its own directory, and the first
deploy records the binding. Afterwards `deploy`, `info`, `rm`, `logs`, and
`env` run there with no `--name`/`--id`:

```sh
cd frontend
pbc frontend deploy --new web   # create "web", bind ./ to it
pbc frontend deploy     # no flags — redeploys the bound frontend
pbc frontend info       # no flags — describes it
```

There is no link command — the file is the link. Deploys write the binding
themselves; `pbc frontend rm` clears it. To detach a directory without touching
the cloud resource, edit `pbc.json` by hand.

(`logs` still takes its kind — `pbc logs pocketbase` or `pbc logs backend` —
because it is one command over two resource types. Frontends are static files
and have no logs.)

The binding lives in `pbc.json`. Each file carries its own `projectId`, so
directories stay independent — and every command run under one resolves to that
project automatically (the file is found by walking up parent directories):

```jsonc
// frontend/pbc.json
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
`pbc project use <name|id>`.

### Environments

One directory can deploy to several environments — staging and production, say.
Each is its own cloud resource in the **same** project; everything they share
(the project, the kind, the build) is written once, and each environment lists
only what differs:

```jsonc
// frontend/pbc.json
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
pbc frontend deploy                             # production
pbc frontend deploy --env staging               # staging
pbc frontend deploy --env staging --new web-staging   # create it
PBC_ENV=staging pbc frontend deploy             # for a whole shell (CI)
```

A `--env` naming an environment the file does not have is an error everywhere
except `deploy`, which creates it — and, like a first deploy, wants a `--new`
to name the resource it creates.

`--env` works the same way on `info`, `rm`, `logs`, and `env`, so
`pbc env set API_KEY=… --target backend --env staging` writes to staging
only. `pbc environments` lists what the file records; delete an environment's
entry from `pbc.json` to forget it.

## Building and deploying

`deploy` builds the project, packages the right files, and uploads them:

```sh
cd web
pbc deploy --new web            # detects the kind, then does all that
pbc frontend deploy --new web   # the same deploy, kind named yourself
```

### One deploy command for all three

`pbc deploy` works out whether the directory holds a PocketBase instance,
a static site, or a backend, and runs that kind's deploy. Nothing else changes:
every flag the three commands take works here and is passed straight through,
so the deploy that runs is the one you would have typed.

It says what it decided, and on the strength of which file:

```
$ pbc deploy
Detected a frontend (vite.config.ts) — running `pbc frontend deploy`.
```

The answer comes from the first of these that applies:

| # | Evidence | Kind |
| - | -------- | ---- |
| 1 | the `kind` in `pbc.json` (written by a previous deploy) | as recorded |
| 2 | `pb_hooks/`, `pb_migrations/`, or `pb_public/` | PocketBase |
| 3 | `next.config.*` with `output: "export"` … | frontend |
|   | … `next.config.*` with anything else | backend |
| 4 | `vite` / `svelte` / `vue` config, or `angular.json` | frontend |
| 5 | `deno.json(c)` | backend |
| 6 | a server dependency in `package.json` (express, fastify, hono, nest, …) | backend |
|   | a bundler dependency (vite, react-scripts, parcel, …) | frontend |
|   | failing both: a `start` script | backend |
|   | failing that: a `build` script | frontend |
| 7 | `index.html` in the directory or in `public/`, `dist/`, `build/`, `out/` | frontend |

Rule 1 is why a redeploy is never re-guessed: once the platform holds a
frontend for this directory, adding a `deno.json` cannot start deploying a
backend over it.

A leading kind word overrides the detection outright, which is also how you
deploy a directory that matches none of the rules:

```sh
pbc deploy backend        # deploy as a backend, whatever is here
pbc deploy frontend web   # …and redeploy the existing "web"
```

When nothing points either way, a terminal is asked; `--no-input` and `--json`
get an error naming the three explicit commands instead of a prompt.

### Which resource a command acts on

A `pbc <kind> <verb>` names a resource, and everything else — its project,
environment, compute — comes back with it. The resolution order:

1. **The `pbc.json` link** in this directory (or an ancestor) — used with no
   flags, printed so it is visible.
2. **A name you pass** — `pbc pocketbase deploy api-db`, or `acme-prod/api-db`
   when two projects share the name. Resolved across every project; `--project`
   only narrows the search, it is never required.
3. **`--new <name>`** on `deploy` — creates. `--name` never creates: a name
   that matches nothing is an error suggesting the nearest one, or `--new`.
4. **A menu**, on a terminal, listing every candidate plus "create new".
5. **An error** naming all three ways out, under `--no-input` / `--json` / no
   TTY.

Read verbs (`info`, `logs`, `domain status`) use the one obvious candidate;
write verbs (`deploy`, `rm`, `env set`, `domain add`) always want a link, a
name, or a menu answer — "it was the only one" is not intent. `--yes` skips a
confirmation, it never picks a target.

**The CI contract:** a pipeline either commits `pbc.json` or names the target
on the command line. It can never inherit one from the shape of the account.

How to build and what to package lives in a `build` block in `pbc.json`. You
never have to write it — the first deploy infers it from the directory, prints
what it found, and records it. Run `pbc init` to do that step on its own
and review the guess before anything ships:

```jsonc
// web/pbc.json
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
static site, so deploy it with `pbc frontend deploy`.

```jsonc
// api/pbc.json
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

The same applies to `pbc pocketbase deploy` and `pbc frontend deploy`: they
pick a compute whenever there is one to pick — on Pro, and in a project shared
with an organization. On the free and starter plans the platform places the
deploy in its shared pool by capacity, so `--compute` is unnecessary there.
`pbc compute ls` lists the ids the flag accepts. (`--server` is the flag's
former name and still works.)

### PocketBase

`pbc.json` records where the three PocketBase directories live, so they can sit
anywhere:

```jsonc
// db/pbc.json
{
  "build": {
    "pbPublic": "pb_public",
    "pbHooks": "pb_hooks",
    "pbMigrations": "pb_migrations"
  }
}
```

They are packaged and shipped when the instance is **created**. The platform
reads that archive only at creation, so a later `pbc pocketbase deploy` pushes the
`.js` and `.json` files in `pb_hooks/` instead and tells you that `pb_public`
and `pb_migrations` were left as they are.

PocketBase only runs `*.pb.js`, but the plain `.js` and `.json` files beside
them go up as well — a hook that `require()`s a helper module or a data file
needs it on the instance too. Hooks are stored as flat files, so a
subdirectory of `pb_hooks/` is not uploaded and the deploy names the ones it
skipped. A push carries at most **30** files — more than that is nearly always
the wrong directory, so `pbc` stops rather than uploading it.

### Environment variables

**Nothing is pushed unless you name the file**, and each environment names its
own — a `.env` holding localhost URLs and test keys has no business in
production. The first deploy of an environment asks once and records the answer
in `pbc.json`:

```sh
$ pbc pocketbase deploy --env prod

No env file configured for environment "prod".
  1) Don't push env vars
  2) .env.prod
  3) .env
  4) Enter a path…
> 2
```

```jsonc
// pbc.json — the answer, and one per environment
"environments": {
  "prod":    { "id": "…", "name": "api",     "build": { "envFile": ".env.prod" } },
  "staging": { "id": "…", "name": "api-stg", "build": { "envFile": ".env.staging" } },
  "dev":     { "id": "…", "name": "api-dev", "build": { "envFile": "" } }
}
```

`""` means "no env file for this environment" — a recorded answer, so the
question is never asked again. Edit `pbc.json` to change any of them.

```sh
pbc backend deploy                        # pushes what pbc.json configures
pbc backend deploy --env-file .env.prod   # names it outright
pbc backend deploy --skip-env             # pushes nothing this run
pbc backend deploy --delete-missing       # the file is the whole truth
pbc backend deploy --force-env            # push even if nothing changed
```

`--env-file` is also recorded, but only for an environment that has no `envFile`
yet — a deploy never overwrites a choice already in the file. Keys in the file
are written and cloud-only keys left alone (unless `--delete-missing`); a file
named but not found fails the deploy before anything is provisioned. Values are
never printed, and dotenv files never go into the zip.

**Unchanged variables are not re-uploaded.** Each push remembers a digest of
what it wrote — the parsed variables, so a reordered key or an edited comment is
not a change — in `~/.config/pbc/env-state.json`, and the next deploy of the same
resource skips the upload when the file still hashes to it:

```
Env vars unchanged since the last push — skipped .env.prod (--force-env pushes anyway).
```

Only the upload is skipped — nothing about what a push *does* changes, so a key
you delete from the file is still left alone in the cloud unless you pass
`--delete-missing`. The digest is per resource, not per file, and `env
set`/`env rm` clear it so a variable changed out of band is never masked. It is only a cache: on a machine
that has never deployed this resource (CI, a teammate's laptop) the file is
simply pushed. Use `--force-env` when the store was edited in the portal.

Under `--no-input` or `--json` nothing is asked, nothing is pushed unless
configured, and `pbc.json` is never written — so CI names its file explicitly.

Frontends have no cloud env store — their variables are baked in at build time.

## Common tasks

### Ship a full-stack app

One directory per resource, each linked once. They can all live in the same repo
and the same cloud project:

```sh
pbc login
pbc project create my-app
pbc project use my-app

cd db  && pbc pocketbase deploy --new my-app-db        # PocketBase + hooks + migrations
cd ../api && pbc backend deploy --new my-app-api  # Pro plan only
cd ../web && pbc frontend deploy --new my-app-web
```

Each deploy prints what it packaged, records the binding in that directory's
`pbc.json`, and asks once which dotenv file this environment uses. From then on a bare
`pbc <kind> deploy` in the same directory redeploys it.

### Create a database with nothing in it

`pbc pocketbase create` provisions an instance and stops there — no build, no
archive, nothing uploaded. It is the command for a script, a CI step, or the
moment before there is anything to deploy:

```sh
pbc pocketbase create my-app-db                  # asks for the name if you omit it
pbc pocketbase create my-app-db --json           # id, URL and the generated login
```

The superuser password is generated and printed once (`pbc pocketbase info`
recovers it). A name already used in the project is refused rather than
duplicated — redeploy that one with `pbc pocketbase deploy --name my-app-db`.

The instance is recorded in the directory's `pbc.json` exactly as a deploy would
record it, so shipping files to it later takes no flags:

```sh
pbc pocketbase create my-app-db   # in the directory the project will live in
# …add pb_hooks/, pb_migrations/, pb_public/
pbc pocketbase deploy             # no --name: the binding is already there
```

`--env <name>` records it under another environment (default: `production`, or
whatever the file's default is). A directory bound to frontends or backends is
refused, and so is an environment that already names an instance — repointing
it would leave the old one with nothing pointing at it.

`pbc pocketbase deploy` creates an instance too, and creates it **empty** when the
directory holds no `pb_public`, `pb_hooks` or `pb_migrations` — it sends no
archive at all and says so, rather than reporting a silent success. So neither
command requires you to have files ready; `create` is the one that never builds
or uploads anything.

### Promote staging to production

```sh
cd web
pbc frontend deploy --new web-staging --env staging   # first deploy creates + links
pbc environments                                      # show what this directory targets
pbc frontend deploy --new web --env production        # production isn't linked yet
pbc frontend deploy --env production                  # from now on, no flags
```

### Update a running instance

A redeploy ships the same directories as the first deploy. Hooks go through the
hooks route (which keeps the portal's editor in sync); `pb_migrations` and
`pb_public` travel in the archive, which the platform installs on the running
instance — migrations merged with the ones already there, `pb_public` replaced
wholesale, and new migrations applied by the restart that follows:

```sh
cd db
pbc pocketbase deploy            # hooks + pb_migrations + pb_public
pbc pocketbase hooks ls          # what the instance has
pbc pocketbase hooks rm old.pb.js
```

### Work with data on a deployed instance

`pbc admin use` points the instance commands at any PocketBase, cloud-hosted or not:

```sh
pbc pocketbase info --name my-app-db          # URL + generated superuser login
pbc admin use https://<id>.<key>.pocketbasecloud.com
pbc admin login                              # superuser

pbc admin collections create '{"name":"tasks","fields":[
  {"name":"title","type":"text","required":true},
  {"name":"done","type":"bool"}]}'
pbc admin records create tasks '{"title":"first"}'
pbc admin rules set tasks --list-rule '@request.auth.id != ""'
```

### Back up, export, restore

```sh
pbc admin settings backup create              # snapshot on the instance
pbc admin settings backup ls
pbc admin settings backup download <key> --out backup.zip
```

### Manage environment variables

```sh
pbc env ls --target backend --name my-app-api
pbc env set API_KEY=secret --target backend --name my-app-api
pbc env import .env.production --target backend --name my-app-api
pbc env import .env.production --target backend --name my-app-api \
  --delete-missing                 # the file is the whole truth
```

Names only are listed — the platform stores values encrypted and never returns
them in plaintext.

An import merges by default: keys in the file are written, keys only in the
cloud are left alone. `--delete-missing` removes those cloud-only keys instead,
so the instance ends up with exactly what the file lists. The same flag works on
`pbc pocketbase deploy` and `pbc backend deploy`, which push the environment's
configured dotenv file as part of a deploy.

### Diagnose a deploy that went wrong

```sh
pbc pocketbase ls                       # statuses at a glance
pbc pocketbase info --name my-app-db    # status, URL, compute, admin login
pbc logs backend --name my-app-api -f   # follow container logs
```

If a deploy times out, the resource was still created — the error names the
`info` and `rm` commands for it.

A newly created domain needs DNS and a certificate before it answers, even once
the status reads `running`, so the first deploy of a PocketBase, backend, or
frontend prints its URL and then waits for it to respond. Giving up on that wait
is not a failure — the resource is running, and the exit code stays `0`. Under
`--json` the deploy waits just the same and reports the outcome as `reachable`.

Every deploy, first or hundredth, prints where the resource can now be reached
— including a custom domain of your own when one is pointed at it, and saying
so while the platform has yet to verify it:

```
✓ web is running
  https://k3n9x2vqp8rt1zw.a1b2.pocketbasecloud.com
  https://app.mysite.com (custom domain)
```

An unverified one reads `(custom domain — pending)`, which is the answer to
"the deploy worked, so why does my domain show nothing?".

### Custom domains

Every deployable kind — PocketBase, backend, frontend — takes the same four
verbs:

```sh
pbc pocketbase domain add app.mysite.com --name my-app-db
pbc pocketbase domain verify --name my-app-db
pbc pocketbase domain status --name my-app-db        # is it reachable yet?
pbc pocketbase domain remove --name my-app-db

pbc backend domain add api.mysite.com --name my-app-api
pbc frontend domain add www.mysite.com --name my-app-web
```

`domain status` reports whether the platform can reach the domain and exits `0`
either way — the answer is in the output (`data.reachable`), not the exit code.

### Share a project with a team

Sharing happens in the portal — create an organization there, and add the
project to it. Everyone in the organization deploys against the **owner's**
plan and onto the owner's compute, so a member on the free plan can deploy
backends into a shared project whose owner is on Pro — and give them custom
domains. Deleting a resource stays with its owner.

### Run in CI (no browser, no prompts)

**Setting up GitHub Actions? Run `pbc ci init`** — it writes the workflow
file for you, wired to the official
[`pocketbasecloud/cli/action`](./action) (installs `pbc`, deploys, masks a
PocketBase deploy's admin credentials before anything reads the JSON). See
[Deploy from GitHub Actions](https://pocketbasecloud.com/docs/ci-cd/deploying-from-github-actions)
for the walkthrough.

The mechanics, for any other CI: authenticate with a token instead of
`pbc login`, and make every command fail rather than ask:

```sh
export PBC_TOKEN=…            # a PocketBase Cloud user token

pbc whoami --json                             # preflight
pbc frontend deploy --no-input --json   # never prompts; JSON on stdout
```

`PBC_TOKEN` is all a CI job sets: the CLI always talks to PocketBase Cloud's own
hosts.

`--json` prints exactly one JSON object on stdout — progress, spinners and
prompts always go to stderr, so `pbc … --json | jq` is safe. Every result is
an envelope:

```json
{ "ok": true,  "schemaVersion": 1, "data": { "…": "…" } }

{ "ok": false, "schemaVersion": 1,
  "error": { "code": "NOT_AUTHENTICATED", "message": "…",
             "hint": "pbc login", "retryable": false } }
```

`error.hint` is a runnable next step where one exists. Exit codes:

| Code | Meaning | Code | Meaning |
| --- | --- | --- | --- |
| 0 | ok | 5 | forbidden / plan limit |
| 2 | usage — bad flag, no target | 6 | conflict |
| 3 | not found | 7 | platform error |
| 4 | auth | 8 | timeout |

Environments, monorepos, PR previews, and every error a pipeline hits are in
the **[full CI/CD reference](https://pocketbasecloud.com/docs/ci-cd/reference)**.

### Pin a PocketBase version

Deploys use the newest published release unless told otherwise. Pin one to keep
cloud and local identical:

```sh
pbc local install 0.39.9                       # local binary + records the pin in pbc.json
pbc pocketbase deploy --pb-version 0.39.9  # or set it per deploy
```

### Keep `pbc` itself current

`pbc` checks for a newer release of itself at most once a day, and every command
prints a single line on stderr while one is available:

```
Update available: pbc 0.2.3 → 0.2.4. Run `pbc self upgrade`.
```

The command it suggests matches how this copy was installed.

The answer is cached, so the line normally appears **before** the command — it
costs a file read, which is what lets a command that never returns
(`pbc logs --follow`) show it at all. On the once-a-day refresh there is
nothing to say yet, so the check runs **after** the command instead and the line
appears at the end. Either way it never delays the work, and never appears
twice.

The check is skipped under `--json`, when `CI` is set, and when output is
redirected — so it never lands in a pipe or a log. `PBC_NO_UPDATE_CHECK=1` turns
it off entirely, and `pbc self upgrade --check` asks on demand.

## What you can do

Run `pbc --help`, or `pbc <command> --help` for details on any command.

- **Local** — `local init`, `local install`, `local versions`, `local which`:
  manage a pinned PocketBase binary and scaffold projects. `self upgrade`
  updates `pbc` itself.
- **Instance** (`pbc admin use <url>`) — `admin collections`, `admin records`,
  `admin rules`, `admin auth`, `admin settings` (incl. `mail`/`s3`/`backup`),
  `admin cron`, `admin requests`: operate any PocketBase instance.
- **Cloud** — `login`, `logout`, `whoami`, `pocketbase`, `frontend`, `backend`,
  `deploy`, `init`, `project`, `env`, `environments`,
  `compute`/`server`/`locations`, `logs`, `ci init`, custom domains: manage your
  PocketBase Cloud account and deployments. `plan` changes your plan. `logs`
  streams a deployed resource's logs (the instance's own request log is
  `admin requests`); `ci init` writes a GitHub Actions workflow. Data
  import/export is on the portal UI — use `admin settings backup` for data from
  the CLI.

## Supported platforms

macOS (arm64, x64), Linux (arm64, x64), and Windows (x64; Windows-on-ARM runs
the x64 build under emulation). On any other platform, install via Deno from
source (above).

## Links

- PocketBase Cloud: https://pocketbasecloud.com
- Issues & releases: https://github.com/pocketbasecloud/cli

## License

MIT
