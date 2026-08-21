# Deploy to PocketBase Cloud — GitHub Action

Deploy a PocketBase instance, a backend, or a static site on every push.

```yaml
name: Deploy

on:
  push:
    branches: [main]

concurrency:
  group: deploy-production
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pocketbasecloud/cli/action@v0.5.0
        with:
          token: ${{ secrets.PBC_TOKEN }}
```

Two things to do once, before that works:

1. **Deploy once from your own computer** (`pbc cloud login`, then
   `pbc cloud frontend deploy` — or `pbc cloud pb deploy` /
   `pbc cloud backend deploy`). It asks which project and what to call this, and
   writes the answers to `pbc.json`. **Commit that file** — it is what makes the
   `with:` block above need nothing else.
2. **Add the token.** Portal → **Account** → **CLI access token** → **Copy**,
   then in your repository: **Settings → Secrets and variables → Actions → New
   repository secret**, named `PBC_TOKEN`.

`pbc cloud ci init` writes the workflow file for you, filled in from the
directory's `pbc.json`, and prints those two steps with your project's details
in them.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `token` | *(required)* | A PocketBase Cloud access token. Always pass a secret, never a literal. |
| `kind` | `auto` | `auto`, `pb`, `frontend`, or `backend`. `auto` lets the CLI decide from `pbc.json` and the directory. |
| `working-directory` | `.` | The directory holding `pbc.json`. |
| `cli-version` | the action's own version | Which `@pocketbasecloud/cli` to install. |
| `project` | — | Project name or id. Only needed when `pbc.json` is not committed. |
| `name` | — | Resource name. Only needed when `pbc.json` does not name one. |
| `env` | — | The `pbc.json` environment to deploy. |
| `compute` | — | Compute id, for Pro accounts with more than one. |
| `location` | — | Region code for a first deploy. `pbc cloud locations` lists them. |
| `skip-build` | `false` | Upload what a previous step already built. |
| `args` | — | Extra flags, split with shell quoting rules. Unbalanced quotes fail the job rather than deploying on a partial list. |

## Outputs

`url`, `id`, `name`, `status`, `kind`, `environment`.

```yaml
      - uses: pocketbasecloud/cli/action@v0.5.0
        id: deploy
        with:
          token: ${{ secrets.PBC_TOKEN }}
      - run: echo "Live at ${{ steps.deploy.outputs.url }}"
```

## What it handles for you

- **Admin credentials never reach the log.** A PocketBase deploy's record
  carries `adminUsername` and `adminPassword`; GitHub masks only values it has
  been told are secret, and a generated password is not one it can guess. The
  action registers them as masked *before* it reads anything else, publishes
  only six whitelisted fields, and deletes the record when the job ends. This
  is the reason to use the action rather than call `pbc ... --json` yourself.
- **A failed deploy fails the job.** The record is redirected, never piped — in
  a pipeline `$?` is the *last* command's status, so a piped deploy reports
  success no matter what happened.
- **A deploy with no URL is an error**, not a green build showing `https://`.
- **A missing or expired token fails in a second**, at a `whoami` check, rather
  than after a five-minute build.
- **`--no-input`** is always passed, so nothing waits for an answer nobody is
  there to give.

## Two things the action cannot set for you

`timeout-minutes` and `concurrency` are job-level, so they have to be in your
workflow (both are in the example above):

- Without `timeout-minutes`, GitHub lets a wedged deploy run for **six hours**.
  20 is generous.
- Without `concurrency`, two pushes in quick succession deploy the same
  resource at the same time.

## Requirements

- **Node 18+ on the runner.** The action installs the CLI from npm. GitHub's
  `ubuntu-latest`, `macos-latest` and `windows-latest` images all ship it; add
  `actions/setup-node` if yours does not.
- **glibc, not musl.** The CLI binaries are compiled against glibc, so
  `container: node:20-alpine` fails to exec them. Use `node:20-bookworm-slim`
  or a stock runner.
- Supported hosts: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`,
  `win32-x64`.

## Notes

- **Forked pull requests get no secrets.** `token` arrives empty and the action
  stops with a message saying so. Deploy from `push`, or gate the job with
  `if: github.event.pull_request.head.repo.full_name == github.repository`.
- **Frontend environment variables are baked in at build time**, so they belong
  in your own build step. PocketBase and backend variables live on the
  platform — set them once with `pbc cloud env set`.
- Full guides:
  [Deploying from GitHub Actions](https://pocketbasecloud.com/docs/ci-cd/deploying-from-github-actions)
  and the [CI/CD reference](https://pocketbasecloud.com/docs/ci-cd/reference).
