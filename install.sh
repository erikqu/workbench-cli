#!/usr/bin/env bash
# Workbench CLI installer.
#
#   curl -fsSL https://ehq.so/install | bash
#
# Installs from source (Workbench CLI runs on Bun). Bun is installed
# automatically if it is missing. Override any of these with env vars:
#   WORKBENCH_CLI_REPO   GitHub repo slug     (default: erikqu/workbench-cli)
#   WORKBENCH_CLI_REF    branch or tag        (default: main)
#   WORKBENCH_CLI_HOME   checkout location    (default: ~/.local/share/workbench-cli)
#   WORKBENCH_CLI_BIN    where to symlink     (default: ~/.local/bin)
set -euo pipefail

workbench_mode="${1:-cli}"
case "$workbench_mode" in
  --help|-h)
    cat <<'EOF'
Workbench installer

  curl -fsSL https://ehq.so/install | bash
  curl -fsSL https://ehq.so/install | bash -s -- host --relay https://YOUR-RELAY
  curl -fsSL https://ehq.so/install | bash -s -- app

cli   Install or update the terminal workbench (default).
host  Download the remote host companion with its runtime included.
app   Show the published iPhone TestFlight or App Store install link.
EOF
    exit 0 ;;
  cli|--cli) if (($#)); then shift; fi ;;
  host|--host|app|--app)
    shift
    workbench_repo="${WORKBENCH_REPO:-erikqu/workbench-cli}"
    workbench_version="${WORKBENCH_VERSION:-latest}"
    [[ "$workbench_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid GitHub repository" >&2; exit 2; }
    [[ "$workbench_version" == latest || "$workbench_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Use latest or a vX.Y.Z release" >&2; exit 2; }
    if [[ "$workbench_version" == latest ]]; then
      workbench_download_base="https://github.com/$workbench_repo/releases/latest/download"
    else
      workbench_download_base="https://github.com/$workbench_repo/releases/download/$workbench_version"
    fi
    workbench_download_base="${WORKBENCH_DOWNLOAD_BASE:-$workbench_download_base}"
    [[ "$workbench_download_base" == https://* ]] || { echo "Downloads must use HTTPS" >&2; exit 2; }
    workbench_temp="$(mktemp -d)"
    trap 'rm -rf -- "$workbench_temp"' EXIT
    if [[ "$workbench_mode" == host || "$workbench_mode" == --host ]]; then
      curl --proto '=https' --tlsv1.2 -fsSL "${workbench_download_base%/}/install-host.sh" -o "$workbench_temp/install-host.sh"
      WORKBENCH_REPO="$workbench_repo" WORKBENCH_VERSION="$workbench_version" \
        WORKBENCH_DOWNLOAD_BASE="${WORKBENCH_DOWNLOAD_BASE:-}" bash "$workbench_temp/install-host.sh" "$@"
    else
      if (($#)); then echo "app does not accept arguments" >&2; exit 2; fi
      if ! curl --proto '=https' --tlsv1.2 -fsSL "${workbench_download_base%/}/iphone-install-url.txt" -o "$workbench_temp/iphone-url"; then
        echo "An iPhone install link is not published for this release yet." >&2
        echo "Check https://github.com/$workbench_repo for iPhone availability." >&2
        exit 1
      fi
      workbench_app_url="$(tr -d '\r\n' < "$workbench_temp/iphone-url")"
      [[ "$workbench_app_url" =~ ^https://testflight\.apple\.com/join/[A-Za-z0-9]+$ ||
         "$workbench_app_url" =~ ^https://apps\.apple\.com/[^[:space:]]+$ ]] || { echo "Invalid iPhone install link" >&2; exit 1; }
      printf 'Open this link on your iPhone to install Workbench:\n%s\n' "$workbench_app_url"
    fi
    exit 0 ;;
  *) echo "Unknown installer option: $workbench_mode. Use --help." >&2; exit 2 ;;
esac
if (($#)); then echo "The CLI installer does not accept arguments. Use --help." >&2; exit 2; fi

REPO="${WORKBENCH_CLI_REPO:-${WORKBENCH_REPO:-erikqu/workbench-cli}}"
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

# Silvery uses TC39 explicit resource management at module-load time. Older Bun
# releases (including 1.2.22) do not provide AsyncDisposableStack, so checking
# only that `bun` exists lets installation succeed and the app crash on launch.
bun_is_compatible() {
  command -v bun >/dev/null 2>&1 &&
    bun -e 'process.exit(typeof AsyncDisposableStack === "function" ? 0 : 1)' >/dev/null 2>&1
}

if ! bun_is_compatible; then
  if command -v bun >/dev/null 2>&1; then
    info "Bun $(bun --version) is too old; installing a compatible release ..."
  else
    info "Bun not found; installing from https://bun.sh ..."
  fi
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
bun_is_compatible ||
  die "A compatible Bun is still not on PATH. Install the latest Bun from https://bun.sh and re-run."

# Fetch (or update) the source checkout.
if [ -d "$INSTALL_DIR/.git" ]; then
  if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=normal)" ]]; then
    die "Refusing to update because $INSTALL_DIR has local changes."
  fi
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
(cd "$INSTALL_DIR/workbench-ui" && bun install --frozen-lockfile)

# Symlink the launcher onto PATH.
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/workbench-cli" "$BIN_DIR/workbench-cli"
ln -sf "$INSTALL_DIR/bin/workbench-cli" "$BIN_DIR/work"
info "Linked $BIN_DIR/workbench-cli -> $INSTALL_DIR/bin/workbench-cli"
info "Linked $BIN_DIR/work -> $INSTALL_DIR/bin/workbench-cli"

# Friendly checks for the external tools the workbench drives.
command -v tmux >/dev/null 2>&1 ||
  warn "tmux not found — persistent agent/terminal panes need it."
if ! command -v codex >/dev/null 2>&1 &&
  ! command -v cursor-agent >/dev/null 2>&1 &&
  ! command -v claude >/dev/null 2>&1 &&
  ! command -v gemini >/dev/null 2>&1 &&
  ! command -v opencode >/dev/null 2>&1; then
  warn "no supported coding-agent CLI found on PATH; install one or run with --harness <id>."
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add this to your shell profile:
    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

info "Done. Launch it with: workbench-cli (or: work)"
