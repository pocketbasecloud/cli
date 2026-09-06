#!/bin/sh
set -eu

REPO="pocketbasecloud/cli"

err() { echo "install.sh: $*" >&2; exit 1; }
step() { echo "==> $*"; }

uname_s=$(uname -s)
uname_m=$(uname -m)
case "$uname_s" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) err "unsupported OS '$uname_s'. Windows: download the win32 zip from https://github.com/${REPO}/releases/latest and unzip pbc onto your PATH." ;;
esac
case "$uname_m" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) err "unsupported architecture '$uname_m'." ;;
esac

case "${os}-${arch}" in
  darwin-arm64) platform_label="macOS (Apple Silicon)" ;;
  darwin-x64)  platform_label="macOS (Intel)" ;;
  linux-arm64) platform_label="Linux (ARM64)" ;;
  linux-x64)   platform_label="Linux (x64)" ;;
  *) platform_label="${uname_s} ${uname_m}" ;;
esac

version_raw="${PBC_VERSION:-${PB_VERSION:-}}"
version="$(printf '%s' "$version_raw" | sed 's/^v//')"
if [ -n "$version" ]; then
  BASE_URL="https://github.com/${REPO}/releases/download/v${version}"
else
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
fi

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

current="unknown"
if command -v pbc >/dev/null 2>&1; then
  current="$(pbc --version 2>/dev/null | awk '{print $2}')"
  [ -n "$current" ] || current="unknown"
fi

fetch "$tmp/checksums.txt" "checksums.txt"
archive=$(awk '{print $2}' "$tmp/checksums.txt" | grep -E "_${os}_${arch}\.tar\.gz$" | head -n1)
[ -n "$archive" ] || err "no ${os}/${arch} archive listed in checksums.txt"
resolved="$(printf '%s' "$archive" | sed -e 's/^pb_//' -e 's/_.*//')"
[ -n "$version" ] || version="$resolved"

if [ "$current" != "unknown" ] && [ "$current" != "$version" ]; then
  step "Updating pbc from $current to $version"
else
  step "Installing pbc $version"
fi
step "Detected platform: $platform_label"
step "Resolved version: $version"
step "Downloading pbc"

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
step "Installing standalone package to $install_dir/pbc"
mv "$tmp/pb" "$install_dir/pbc"

if ln -sf pbc "$install_dir/pb" 2>/dev/null; then
  :
elif cp "$install_dir/pbc" "$install_dir/pb" 2>/dev/null; then
  echo "install.sh: symlinks are unavailable here, so copied pbc to $install_dir/pb (the pre-0.6.0 name) —" >&2
  echo "install.sh: re-run this installer after an upgrade to keep \`pb\` in step." >&2
else
  echo "install.sh: note — could not add the legacy \`pb\` name in $install_dir." >&2
fi

case ":$PATH:" in
  *":$install_dir:"*) step "$install_dir is already on PATH" ;;
  *) echo "==> $install_dir is not on your PATH — add it to use pbc in future terminals" ;;
esac

echo "pbc $version installed successfully."
