#!/bin/sh
# Installer for the `pbc` CLI. Downloads the prebuilt binary for this host from
# the latest GitHub Release, verifies its SHA-256, and installs it as `pbc`
# with `pb` — the name the CLI had before 0.6.0 — linked beside it.
#
# Overrides (env):
#   PBC_INSTALL_DIR where to install pbc       (default: /usr/local/bin or ~/.local/bin)
#   PB_INSTALL_DIR  the pre-0.6.0 name for it, honoured when PBC_INSTALL_DIR is unset
#   PBC_DIST_DIR    read archives from a local dir instead of GitHub (for testing;
#                   PB_DIST_DIR is honoured too)
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

dist_dir="${PBC_DIST_DIR:-${PB_DIST_DIR:-}}"

fetch() { # fetch <dest-path> <basename>
  dest=$1; name=$2
  if [ -n "$dist_dir" ]; then
    cp "${dist_dir}/${name}" "$dest" || err "missing ${name} in ${dist_dir}"
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
# The file inside the archive is still named `pb`: every already-installed copy
# resolves its self-upgrade by that entry, so the archive layout is frozen even
# though the installed command is now `pbc`.
tar -xzf "$tmp/$archive" -C "$tmp" || err "failed to extract ${archive}"
[ -f "$tmp/pb" ] || err "archive did not contain a pb binary"
chmod 0755 "$tmp/pb"

install_dir="${PBC_INSTALL_DIR:-${PB_INSTALL_DIR:-}}"
if [ -z "$install_dir" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then install_dir="/usr/local/bin";
  else install_dir="$HOME/.local/bin"; fi
fi
mkdir -p "$install_dir"
mv "$tmp/pb" "$install_dir/pbc"
echo "install.sh: installed pbc to $install_dir/pbc"

# `pb` is what this CLI was called before 0.6.0. It stays on PATH as a link so
# existing scripts keep working, and a link rather than a copy so that one
# `pbc upgrade` moves both names at once.
if ln -sf pbc "$install_dir/pb" 2>/dev/null; then
  echo "install.sh: linked $install_dir/pb -> pbc (the pre-0.6.0 name)."
elif cp "$install_dir/pbc" "$install_dir/pb" 2>/dev/null; then
  # A copy, not a link, so `pbc upgrade` will move pbc and leave this behind.
  echo "install.sh: copied pbc to $install_dir/pb (the pre-0.6.0 name) —"
  echo "install.sh: symlinks are unavailable here, so re-run this installer"
  echo "install.sh: after an upgrade to keep \`pb\` in step."
else
  echo "install.sh: note — could not add the legacy \`pb\` name in $install_dir." >&2
fi
echo "install.sh: update it later with \`pbc upgrade\`."

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "install.sh: note — $install_dir is not on your PATH." >&2 ;;
esac
