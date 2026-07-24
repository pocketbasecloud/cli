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

## What you can do

Run `pb --help`, or `pb <command> --help` for details on any command.

- **Local** — `init`, `install`, `versions`, `which`: manage a pinned
  PocketBase binary and scaffold projects.
- **Instance** (`pb use <url>`) — `collections`, `records`, `rules`, `auth`,
  `settings` (incl. `mail`/`s3`/`backup`), `cron`, `logs`: operate any
  PocketBase instance.
- **Cloud** (`pb cloud ...`) — `project`, `pb`, `backend`, `frontend`, `env`,
  `logs`, `org`, `data` import/export, custom domains: manage your PocketBase
  Cloud account and deployments.

## Supported platforms

macOS (arm64, x64), Linux (arm64, x64), and Windows (x64; Windows-on-ARM runs
the x64 build under emulation). On any other platform, install via Deno from
source (above).

## Links

- PocketBase Cloud: https://pocketbasecloud.com
- Issues & releases: https://github.com/pocketbasecloud/cli

## License

MIT
