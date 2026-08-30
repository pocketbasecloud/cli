#!/bin/sh
set -eu

REPO="pocketbasecloud/cli"
BASE_URL="https://github.com/${REPO}/releases/latest/download"

err() { echo "install.sh: $*" >&2; exit 1; }

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

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

dist_dir="${PBC_DIST_DIR:-${PB_DIST_DIR:-}}"

fetch() {
  dest=$1; name=$2
  if [ -n "$dist_dir" ]; then
    cp "${dist_dir}/${name}" "$dest" || err "missing ${name} in ${dist_dir}"
  else
    curl -fsSL -o "$dest" "${BASE_URL}/${name}" || err "download failed: ${name}"
  fi
}

fetch "$tmp/checksums.txt" "checksums.txt"
archive=$(awk '{print $2}' "$tmp/checksums.txt" | grep -E "_${os}_${arch}\.tar\.gz$" | head -n1)
[ -n "$archive" ] || err "no ${os}/${arch} archive listed in checksums.txt"
fetch "$tmp/$archive" "$archive"

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

if ln -sf pbc "$install_dir/pb" 2>/dev/null; then
  echo "install.sh: linked $install_dir/pb -> pbc (the pre-0.6.0 name)."
elif cp "$install_dir/pbc" "$install_dir/pb" 2>/dev/null; then
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
