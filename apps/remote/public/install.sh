#!/usr/bin/env bash
# Install a released companion, including its Node runtime, without a source checkout.
set -euo pipefail

workbench_repo="${WORKBENCH_REPO:-erikqu/workbench-cli}"
workbench_version="${WORKBENCH_VERSION:-latest}"
workbench_relay=""
workbench_install_root="${WORKBENCH_HOST_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/workbench-remote}"
workbench_bin="${WORKBENCH_HOST_BIN:-$HOME/.local/bin}"
workbench_download_base="${WORKBENCH_DOWNLOAD_BASE:-}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: install-host.sh [--relay https://relay.example.com] [--version vX.Y.Z]

Install the Workbench host companion and bundled runtime on Linux or macOS.
Pairing is a separate interactive step; this installer never grants device access.

Environment: WORKBENCH_REPO, WORKBENCH_VERSION, WORKBENCH_HOST_HOME,
             WORKBENCH_HOST_BIN, WORKBENCH_DOWNLOAD_BASE
EOF
}
while (($#)); do
  case "$1" in
    --relay) [[ $# -ge 2 ]] || die "Missing relay URL"; workbench_relay="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || die "Missing version"; workbench_version="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ "$workbench_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "Invalid GitHub repository"
[[ "$workbench_version" == latest || "$workbench_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Use latest or a vX.Y.Z release"
[[ -z "$workbench_relay" || "$workbench_relay" == https://* ]] || die "The relay must use HTTPS"
case "$(uname -s)" in Linux) workbench_platform=linux ;; Darwin) workbench_platform=darwin ;; *) die "Linux and macOS are supported" ;; esac
case "$(uname -m)" in x86_64) workbench_arch=x64 ;; aarch64|arm64) workbench_arch=arm64 ;; *) die "Unsupported processor architecture" ;; esac
command -v curl >/dev/null || die "curl is required"
command -v tar >/dev/null || die "tar is required"
command -v tmux >/dev/null || die "Install tmux first, then rerun this installer"
if [[ -z "$workbench_download_base" ]]; then
  if [[ "$workbench_version" == latest ]]; then
    workbench_download_base="https://github.com/$workbench_repo/releases/latest/download"
  else
    workbench_download_base="https://github.com/$workbench_repo/releases/download/$workbench_version"
  fi
fi
[[ "$workbench_download_base" == https://* ]] || die "Downloads must use HTTPS"
workbench_archive="workbench-host-$workbench_platform-$workbench_arch.tar.gz"
workbench_temp="$(mktemp -d)"
trap 'rm -rf -- "$workbench_temp"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL "${workbench_download_base%/}/$workbench_archive" -o "$workbench_temp/$workbench_archive"
curl --proto '=https' --tlsv1.2 -fsSL "${workbench_download_base%/}/$workbench_archive.sha256" -o "$workbench_temp/checksum"
workbench_expected="$(awk 'NR == 1 {print $1}' "$workbench_temp/checksum")"
if command -v sha256sum >/dev/null; then
  workbench_actual="$(sha256sum "$workbench_temp/$workbench_archive" | awk '{print $1}')"
else
  command -v shasum >/dev/null || die "sha256sum or shasum is required"
  workbench_actual="$(shasum -a 256 "$workbench_temp/$workbench_archive" | awk '{print $1}')"
fi
[[ "$workbench_expected" =~ ^[a-f0-9]{64}$ && "$workbench_expected" == "$workbench_actual" ]] || die "Download checksum mismatch"
workbench_install="$workbench_install_root/${workbench_expected:0:12}"
mkdir -p "$workbench_bin"
workbench_link="$workbench_bin/workbench-remote"
if [[ -e "$workbench_link" || -L "$workbench_link" ]]; then
  [[ -L "$workbench_link" ]] || die "Refusing to replace unrelated file $workbench_link"
  case "$(readlink "$workbench_link")" in "$workbench_install_root/"*) ;; *) die "Refusing to replace unrelated symlink $workbench_link" ;; esac
fi
if [[ ! -d "$workbench_install" ]]; then
  workbench_prefix="workbench-host-$workbench_platform-$workbench_arch"
  # Check all paths before extraction. No absolute paths or parent traversal.
  tar -tzf "$workbench_temp/$workbench_archive" > "$workbench_temp/entries"
  while IFS= read -r workbench_entry; do
    case "$workbench_entry" in "$workbench_prefix"|"$workbench_prefix/"*) ;; *) die "Unexpected archive layout" ;; esac
    case "/$workbench_entry/" in */../*) die "Unsafe archive path" ;; esac
  done < "$workbench_temp/entries"
  mkdir -p "$workbench_temp/unpacked" "$workbench_install_root"
  tar -xzf "$workbench_temp/$workbench_archive" -C "$workbench_temp/unpacked" --strip-components=1
  [[ -x "$workbench_temp/unpacked/bin/workbench-remote" && -x "$workbench_temp/unpacked/bin/node" ]] || die "Release is missing its launcher or runtime"
  "$workbench_temp/unpacked/bin/workbench-remote" help >/dev/null
  mv "$workbench_temp/unpacked" "$workbench_install"
fi
ln -sfn "$workbench_install/bin/workbench-remote" "$workbench_link"
printf 'Installed Workbench companion: %s\n' "$workbench_link"
if [[ -n "$workbench_relay" ]]; then
  printf 'Pair this machine: %q setup --relay %q\n' "$workbench_link" "$workbench_relay"
else
  printf 'Pair this machine: %q setup --relay https://YOUR-RELAY\n' "$workbench_link"
fi
printf 'After pairing, run: %q service\n' "$workbench_link"
