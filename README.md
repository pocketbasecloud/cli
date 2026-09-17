# `pbc` — PocketBase Cloud CLI

One tool to run PocketBase locally, deploy to [PocketBase Cloud](https://pocketbasecloud.com), and manage any PocketBase instance — from your terminal.

```sh
pbc local init      # download PocketBase + scaffold here
./pocketbase serve  # run it locally

pbc login           # browser login
pbc deploy          # detect kind, build, deploy; asks which project
pbc logs pocketbase --name my-app-db
```

Works against any instance, not just the cloud:

```sh
pbc admin login --url https://my-instance.example.com
pbc admin collections ls
pbc admin records ls posts
```

Keep several instances — or several superusers on one — at once:
`pbc admin login --url <url> --name <profile>` saves each, `pbc admin profiles`
lists them (the active one starred), and `pbc admin use --name <profile>` or
`--profile <profile>` switches between them.

`pbc --help` lists everything. `pbc <command> --help` explains one command.

## Install

macOS/Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/pocketbasecloud/cli/main/scripts/install.sh | sh
```

Pin a version with `PBC_VERSION=0.8.2`. Verifies SHA-256, installs to
`/usr/local/bin` (or `~/.local/bin`, override with `PBC_INSTALL_DIR`). On
Windows, unzip the win32 zip from
[releases](https://github.com/pocketbasecloud/cli/releases/latest) onto your
PATH. npm installs (`@pocketbasecloud/cli`) are deprecated — reinstall once
from the script above. From source:

```sh
git clone https://github.com/pocketbasecloud/cli
cd cli
deno install -g -A -c deno.json -n pbc ./main.ts
```

## Deploy

`pbc deploy` detects what the directory holds — a PocketBase instance, a
frontend, or a backend — and runs the matching deploy. `pbc init` records the
guess in `pbc.json` without deploying; the first deploy of a directory writes
its binding there, so redeploys need no flags:

```sh
pbc deploy                # detect what this directory is
pbc frontend deploy       # or name the kind outright
pbc deploy --env staging  # one directory, several environments
```

The project is picked at runtime: the CLI asks which one to use until the
directory is linked, and `--project <id>` answers without a prompt.
`pbc environments` lists what a directory targets. `pbc deploy --help` covers
detection, build config, and the env-push flags.

## Scripting and CI

```sh
export PBC_TOKEN=…              # portal → Account → CLI access token
pbc whoami --json               # preflight
pbc frontend deploy --no-input --json
```

- `pbc login --token <t>` saves that same access token to the local config instead of exporting it — handy on a headless box you'll run several sessions on.
- `--json` prints one `{ ok, schemaVersion, data|error }` object on stdout; progress goes to stderr, so piping to `jq` is safe.
- `--yes` skips confirmations; `--no-input` fails instead of prompting.
- `pbc ci init` writes the GitHub workflow using [`pocketbasecloud/cli/action`](./action). Full reference: [CI/CD docs](https://pocketbasecloud.com/docs/ci-cd/deploying-from-github-actions).

## Old names still work

`pb`, `pb.json`, and `PB_*` vars (pre-0.6.0), plus `pbc cloud …`, `pbc init|install|versions|which|upgrade`, and bare `collections|records|rules|…` (pre-0.8.0), all run and print the new spelling. New code should use `pbc`, `pbc.json`, `PBC_*`, `pbc local …`, `pbc self upgrade`, and `pbc admin …`.

## Platforms

macOS/Linux (arm64, x64), Windows x64 (runs under emulation on ARM). Anything else: install from source above.

## Links

- PocketBase Cloud: https://pocketbasecloud.com
- Issues & releases: https://github.com/pocketbasecloud/cli

MIT
