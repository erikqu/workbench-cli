#!/usr/bin/env bash
# Workbench CLI installer.
#
#   curl -fsSL https://erikq.co/install | bash
#
# Installs from source (Workbench CLI runs on Bun). Bun is installed
# automatically if it is missing. Override any of these with env vars:
#   WORKBENCH_CLI_REPO   GitHub repo slug     (default: erikqu/workbench-cli)
#   WORKBENCH_CLI_REF    branch or tag        (default: main)
#   WORKBENCH_CLI_HOME   checkout location    (default: ~/.local/share/workbench-cli)
#   WORKBENCH_CLI_BIN    where to symlink     (default: ~/.local/bin)
set -euo pipefail

REPO="${WORKBENCH_CLI_REPO:-erikqu/workbench-cli}"
REF="${WORKBENCH_CLI_REF:-main}"
INSTALL_DIR="${WORKBENCH_CLI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/workbench-cli}"
BIN_DIR="${WORKBENCH_CLI_BIN:-$HOME/.local/bin}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is required."
command -v curl >/dev/null 2>&1 || die "curl is required."

# Bun is the runtime. Install it if it isn't already on PATH.
if ! command -v bun >/dev/null 2>&1; then
  info "Bun not found; installing from https://bun.sh ..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 ||
  die "Bun is still not on PATH. Install it from https://bun.sh and re-run."

# Fetch (or update) the source checkout.
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing checkout in $INSTALL_DIR ..."
  git -C "$INSTALL_DIR" remote set-url origin "https://github.com/$REPO.git"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF"
  git -C "$INSTALL_DIR" checkout -q --detach FETCH_HEAD
else
  info "Cloning $REPO@$REF into $INSTALL_DIR ..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

info "Installing dependencies ..."
(cd "$INSTALL_DIR/workbench-ui" && bun install)

# Symlink the launcher onto PATH.
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/workbench-cli" "$BIN_DIR/workbench-cli"
info "Linked $BIN_DIR/workbench-cli -> $INSTALL_DIR/bin/workbench-cli"

# Friendly checks for the external tools the workbench drives.
command -v tmux >/dev/null 2>&1 ||
  warn "tmux not found — persistent agent/terminal panes need it."
command -v claude >/dev/null 2>&1 ||
  warn "no 'claude' on PATH (the default harness); install an agent CLI or run with --harness <id>."

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add this to your shell profile:
    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

info "Done. Launch it with: workbench-cli"
