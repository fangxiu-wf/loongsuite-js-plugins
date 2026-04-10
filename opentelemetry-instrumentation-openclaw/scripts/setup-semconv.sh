#!/usr/bin/env bash
# setup-semconv.sh — Add or remove LOONGSUITE_SEMCONV_DIALECT_NAME env var
# from shell profiles. Called by install.sh and uninstall.sh.
#
# Usage:
#   bash setup-semconv.sh --install ALIBABA_CLOUD   # default
#   bash setup-semconv.sh --install ALIBABA_GROUP
#   bash setup-semconv.sh --remove

set -euo pipefail

SEMCONV_MARKER='# BEGIN openclaw-cms-plugin-semconv-dialect'
SEMCONV_MARKER_END='# END openclaw-cms-plugin-semconv-dialect'

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
error(){ echo -e "${RED}[ERROR]${NC} $*" >&2; }

MODE="${1:-}"
DIALECT="${2:-ALIBABA_CLOUD}"

if [[ "$MODE" != "--install" && "$MODE" != "--remove" ]]; then
  error "Usage: $0 --install [ALIBABA_CLOUD|ALIBABA_GROUP] | --remove"
  exit 1
fi

if [[ "$MODE" == "--install" ]] && \
   [[ "$DIALECT" != "ALIBABA_CLOUD" && "$DIALECT" != "ALIBABA_GROUP" ]]; then
  error "Unknown dialect '$DIALECT'. Must be ALIBABA_CLOUD or ALIBABA_GROUP."
  exit 1
fi

SEMCONV_ENV_LINE="export LOONGSUITE_SEMCONV_DIALECT_NAME=${DIALECT}"

# ── Install: write env var block ──
install_to_file() {
  local file="$1"
  [[ -f "$file" ]] || return
  # Remove existing block first (in case dialect changed)
  if grep -q "$SEMCONV_MARKER" "$file" 2>/dev/null; then
    sed -i "/^${SEMCONV_MARKER}$/,/^${SEMCONV_MARKER_END}$/d" "$file"
  fi
  cat >> "$file" << BLOCK

${SEMCONV_MARKER}
${SEMCONV_ENV_LINE}
${SEMCONV_MARKER_END}
BLOCK
  ok "Written to $file"
}

# ── Remove: delete env var block ──
remove_from_file() {
  local file="$1"
  [[ -f "$file" ]] || return
  if ! grep -q "$SEMCONV_MARKER" "$file" 2>/dev/null; then
    return
  fi
  sed -i "/^${SEMCONV_MARKER}$/,/^${SEMCONV_MARKER_END}$/d" "$file"
  ok "Removed from $file"
}

PROFILES=("$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile")

if [[ "$MODE" == "--install" ]]; then
  info "Setting LOONGSUITE_SEMCONV_DIALECT_NAME=${DIALECT} in shell profiles..."
  for f in "${PROFILES[@]}"; do install_to_file "$f"; done
else
  for f in "${PROFILES[@]}"; do remove_from_file "$f"; done
  info "Please reload your shell: source ~/.bashrc  # or ~/.zshrc"
fi
