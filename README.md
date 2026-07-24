# @pocketbasecloud/cli

The `pb` command-line tool for [PocketBase Cloud](https://pocketbasecloud.com)
and local PocketBase development.

## Install

```sh
npm i -g @pocketbasecloud/cli
```

or, on macOS/Linux, without Node:

```sh
curl -fsSL https://raw.githubusercontent.com/pocketbasecloud/cli/main/scripts/install.sh | sh
```

## Usage

```sh
pb --help          # list every command
pb init            # scaffold a new project and start PocketBase locally
pb install         # download a local PocketBase binary
pb versions        # list available PocketBase versions
```

Windows users install via npm. On Windows-on-ARM the x64 build runs under
emulation.

## Supported platforms

macOS (arm64, x64), Linux (arm64, x64), Windows (x64; arm64 via emulation).
On any other platform, install Deno and run from source:
`deno install -A -n pb <repo>/cli/main.ts`.

## License

MIT
