#!/bin/bash
set -euo pipefail
workbench_relay=""
while [ "$#" -gt 0 ]; do
  case "$1" in --relay) workbench_relay=${2:?Missing relay URL}; shift 2 ;; *) echo "Usage: install.sh --relay https://relay.example" >&2; exit 1 ;; esac
done
case "$workbench_relay" in https://*) ;; *) echo "Provide an HTTPS relay URL." >&2; exit 1 ;; esac
workbench_relay=${workbench_relay%/}
case "$(uname -s)" in Linux) workbench_platform=linux ;; Darwin) workbench_platform=darwin ;; *) echo "Linux and macOS are supported." >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64) workbench_arch=x64 ;; aarch64|arm64) workbench_arch=arm64 ;; *) echo "Unsupported processor architecture." >&2; exit 1 ;; esac
command -v tmux >/dev/null || { echo "Install tmux first, then rerun this installer." >&2; exit 1; }
workbench_archive="workbench-host-${workbench_platform}-${workbench_arch}.tar.gz"
workbench_temp=$(mktemp -d)
trap 'rm -rf -- "$workbench_temp"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL "$workbench_relay/downloads/$workbench_archive" -o "$workbench_temp/$workbench_archive"
curl --proto '=https' --tlsv1.2 -fsSL "$workbench_relay/downloads/$workbench_archive.sha256" -o "$workbench_temp/checksum"
workbench_expected=$(awk 'NR==1 {print $1}' "$workbench_temp/checksum")
if command -v sha256sum >/dev/null; then workbench_actual=$(sha256sum "$workbench_temp/$workbench_archive" | awk '{print $1}'); else workbench_actual=$(shasum -a 256 "$workbench_temp/$workbench_archive" | awk '{print $1}'); fi
[[ "$workbench_expected" =~ ^[a-f0-9]{64}$ ]] && [ "$workbench_expected" = "$workbench_actual" ] || { echo "Download checksum mismatch." >&2; exit 1; }
workbench_install="$HOME/.local/share/workbench-remote/${workbench_expected:0:12}"
if [ ! -d "$workbench_install" ]; then
  mkdir -p "$workbench_temp/unpacked" "$(dirname "$workbench_install")"
  tar -xzf "$workbench_temp/$workbench_archive" -C "$workbench_temp/unpacked" --strip-components=1
  mv "$workbench_temp/unpacked" "$workbench_install"
fi
mkdir -p "$HOME/.local/bin"
workbench_link="$HOME/.local/bin/workbench-remote"
if [ -e "$workbench_link" ] || [ -L "$workbench_link" ]; then
  if [ ! -L "$workbench_link" ]; then echo "$workbench_link already exists; use $workbench_install/bin/workbench-remote directly." >&2; exit 1; fi
  case "$(readlink "$workbench_link")" in "$HOME/.local/share/workbench-remote/"*) ;; *) echo "An unrelated workbench-remote link already exists." >&2; exit 1 ;; esac
fi
ln -sfn "$workbench_install/bin/workbench-remote" "$workbench_link"
echo "Installed Workbench Remote. Pair this machine:"
printf '  %q setup --relay %q\n' "$workbench_link" "$workbench_relay"
echo "Then run workbench-remote service to connect automatically. Keep ~/.local/bin on your PATH."
