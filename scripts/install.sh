#!/bin/sh
# Installer for the `pb` CLI. Downloads the prebuilt binary for this host from
# the latest GitHub Release, verifies its SHA-256, and installs it.
#
# Overrides (env):
#   PB_INSTALL_DIR  where to install pb        (default: /usr/local/bin or ~/.local/bin)
#   PB_DIST_DIR     read archives from a local dir instead of GitHub (for testing)
set -eu

REPO="pocketbasecloud/cli"
BASE_URL="https://github.com/${REPO}/releases/latest/download"

err() { echo "install.sh: $*" >&2; exit 1; }

# --- detect host -> asset name --------------------------------------------
uname_s=$(uname -s)
uname_m=$(uname -m)
case "$uname_s" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) err "unsupported OS '$uname_s'. Windows users install via: npm i -g @pocketbasecloud/cli" ;;
esac
case "$uname_m" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) err "unsupported architecture '$uname_m'." ;;
esac

# --- fetch archive + checksums into a temp dir ----------------------------
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() { # fetch <dest-path> <basename>
  dest=$1; name=$2
  if [ -n "${PB_DIST_DIR:-}" ]; then
    cp "${PB_DIST_DIR}/${name}" "$dest" || err "missing ${name} in PB_DIST_DIR"
  else
    curl -fsSL -o "$dest" "${BASE_URL}/${name}" || err "download failed: ${name}"
  fi
}

# Resolve the concrete archive name. The `latest/download` redirect needs the
# exact name, so we read it from checksums.txt (which also carries the version).
fetch "$tmp/checksums.txt" "checksums.txt"
archive=$(awk '{print $2}' "$tmp/checksums.txt" | grep -E "_${os}_${arch}\.tar\.gz$" | head -n1)
[ -n "$archive" ] || err "no ${os}/${arch} archive listed in checksums.txt"
fetch "$tmp/$archive" "$archive"

# --- verify SHA-256 -------------------------------------------------------
expected=$(grep " ${archive}\$" "$tmp/checksums.txt" | awk '{print $1}')
[ -n "$expected" ] || err "no checksum for ${archive}"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$archive" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
else
  err "need sha256sum or shasum to verify the download"
fi
[ "$actual" = "$expected" ] || err "checksum mismatch for ${archive} — refusing to install"

# --- extract + install ----------------------------------------------------
tar -xzf "$tmp/$archive" -C "$tmp" || err "failed to extract ${archive}"
[ -f "$tmp/pb" ] || err "archive did not contain a pb binary"
chmod 0755 "$tmp/pb"

install_dir="${PB_INSTALL_DIR:-}"
if [ -z "$install_dir" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then install_dir="/usr/local/bin";
  else install_dir="$HOME/.local/bin"; fi
fi
mkdir -p "$install_dir"
mv "$tmp/pb" "$install_dir/pb"
echo "install.sh: installed pb to $install_dir/pb"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "install.sh: note — $install_dir is not on your PATH." >&2 ;;
esac
