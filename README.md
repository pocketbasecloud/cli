# `pbc` — PocketBase Cloud CLI

One tool to run PocketBase locally, deploy to [PocketBase Cloud](https://pocketbasecloud.com), and manage any PocketBase instance — from your terminal.

```sh
pbc local init      # download PocketBase + scaffold here
./pocketbase serve  # run it locally

pbc login                     # browser login
pbc project create my-app
pbc project use my-app
pbc deploy                    # detect kind, build, deploy
pbc logs pocketbase --name my-app-db
```

Works against any instance, not just the cloud:

```sh
pbc admin use https://my-instance.example.com
pbc admin login
pbc admin collections ls
pbc admin records ls posts
```

`pbc --help` lists everything. `pbc <command> --help` explains one command.

## Install

```sh
npm i -g @pocketbasecloud/cli   # global
npx @pocketbasecloud/cli --help # no install
```

No Node? macOS/Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/pocketbasecloud/cli/main/scripts/install.sh | sh
```

Verifies SHA-256, installs to `/usr/local/bin` (or `~/.local/bin`, override with `PBC_INSTALL_DIR`). From source:

```sh
git clone https://github.com/pocketbasecloud/cli
cd cli
deno install -g -A -c deno.json -n pbc ./main.ts
```

## What it does

- **Local:** `local init|install|versions|which` — pinned PocketBase binary per project.
- **Cloud:** `deploy` (auto-detects kind), `init`, `project create|ls|rm|use`, `pocketbase|backend|frontend deploy|info|ls|rm`, `env ls|set|rm|import`, `environments`, `logs pocketbase|backend`, `plan`, `compute ls`, `locations`, `ci init`, `domain add|verify|status|remove` on each kind — plus `pocketbase create|config|hooks|superuser`.
- **Any instance:** `admin use <url>` + `admin login` once, then `admin collections|records|rules|auth|settings|cron|requests` (`mail|s3|backup` live under `settings`).

`pbc self upgrade` updates the CLI. `pbc plan` changes your plan.

## Deploy

`pbc deploy [pocketbase|frontend|backend] [name]` picks the kind for you: the `kind` in `pbc.json` first (a deployed directory is never re-guessed), then `pb_hooks|pb_migrations|pb_public`, Next/Vite/Svelte/Vue/Angular configs, `deno.json`, `package.json` deps/scripts, `index.html`. Pass the kind to override. `pbc init` writes the guess to `pbc.json` without deploying.

The first deploy writes the binding to `pbc.json`, so redeploys in that directory need no flags (`pbc pocketbase deploy`, `pbc frontend info`, `pbc logs backend`). One directory deploys to several environments with `--env` (or `PBC_ENV`); `pbc environments` lists them.

Build config (`command`, `outputDir`, `runtime`, `envFile`, …) is inferred on first deploy (or via `pbc init`), recorded in `pbc.json`, and never rewritten without `--force`. `pbc pocketbase create` provisions an empty instance with no build or upload. Redeploys push `pb_hooks` through the hooks route (portal editor stays in sync); `pb_migrations` merge, `pb_public` is replaced. Next.js backends deploy as a prebuilt `standalone` bundle — deploy adds `output: "standalone"` to the config for you.

Env vars come only from the dotenv file each environment names — nothing is pushed by default. Merges; `--delete-missing` makes the file the whole truth. Lists show keys only (values are encrypted server-side). Use `pbc env set|ls|rm|import --target pocketbase|backend`. Frontends have no env store; their vars bake in at build time. Backends and PocketBase take `--compute <id>` only when there is a choice (`pbc compute ls`); otherwise the platform places the deploy. Regions: `pbc locations` (what `--location` accepts) — omit it and the platform picks.

## Scripting and CI

```sh
export PBC_TOKEN=…              # portal → Account → CLI access token
pbc whoami --json               # preflight
pbc frontend deploy --no-input --json
```

- `--json` prints one `{ ok, schemaVersion, data|error }` object on stdout; progress goes to stderr, so piping to `jq` is safe.
- `--yes` skips confirmations; `--no-input` fails instead of prompting.
- `pbc ci init` writes the GitHub workflow using [`pocketbasecloud/cli/action`](./action). Full reference: [CI/CD docs](https://pocketbasecloud.com/docs/ci-cd/deploying-from-github-actions).

`pbc` mentions a newer release at most once a day on stderr. Skipped under `--json`, `CI`, or redirected output; `PBC_NO_UPDATE_CHECK=1` disables it.

## Old names still work

`pb`, `pb.json`, and `PB_*` vars (pre-0.6.0), plus `pbc cloud …`, `pbc init|install|versions|which|upgrade`, and bare `collections|records|rules|…` (pre-0.8.0), all run and print the new spelling. New code should use `pbc`, `pbc.json`, `PBC_*`, `pbc local …`, `pbc self upgrade`, and `pbc admin …`.

## Platforms

macOS/Linux (arm64, x64), Windows x64 (runs under emulation on ARM). Anything else: install from source above.

## Links

- PocketBase Cloud: https://pocketbasecloud.com
- Issues & releases: https://github.com/pocketbasecloud/cli

MIT
