#!/usr/bin/env bash
#
# renovate-mcp installer
# https://github.com/tibuntu/renovate-mcp
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tibuntu/renovate-mcp/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/tibuntu/renovate-mcp/main/install.sh | bash -s -- --global
#   curl -fsSL https://raw.githubusercontent.com/tibuntu/renovate-mcp/main/install.sh | bash -s -- --no-mcp-add
#   curl -fsSL https://raw.githubusercontent.com/tibuntu/renovate-mcp/main/install.sh | bash -s -- --version=0.12.0
#
# Flags:
#   --global              Install globally via `npm install -g`.
#   --npx                 Use npx (warm the cache only; no global install).
#   --no-mcp-add          Skip auto-registration with Claude Code.
#   --mcp-scope=<scope>   Claude Code scope: user (default), project, local.
#   --version=<X.Y.Z>     Specific renovate-mcp version (default: latest).
#   -h, --help            Show this help.
#
# Env overrides:
#   RENOVATE_MCP_VERSION       Same as --version=
#   RENOVATE_MCP_GLOBAL=1      Same as --global
#   RENOVATE_MCP_NO_MCP_ADD=1  Same as --no-mcp-add

set -euo pipefail

VERSION="${RENOVATE_MCP_VERSION:-latest}"
GLOBAL="${RENOVATE_MCP_GLOBAL:-}"
NPX_EXPLICIT=0
NO_MCP_ADD="${RENOVATE_MCP_NO_MCP_ADD:-}"
MCP_SCOPE="user"

# Colors (disable on NO_COLOR or non-TTY stdout).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
  BLUE=$'\033[0;34m'; CYAN=$'\033[0;36m'; BOLD=$'\033[1m'
  DIM=$'\033[2m'; NC=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; BOLD=""; DIM=""; NC=""
fi

step()    { printf '%s▸%s %s\n' "$GREEN" "$NC" "$1"; }
substep() { printf '  %s├─%s %s\n' "$DIM" "$NC" "$1"; }
ok()      { printf '%s✓%s %s\n' "$GREEN" "$NC" "$1"; }
warn()    { printf '%s⚠%s %s\n' "$YELLOW" "$NC" "$1"; }
err()     { printf '%s✗%s %s\n' "$RED" "$NC" "$1" >&2; }
info()    { printf '%sℹ%s %s\n' "$BLUE" "$NC" "$1"; }

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --global|-g)         GLOBAL=1; shift ;;
    --npx)               GLOBAL=0; NPX_EXPLICIT=1; shift ;;
    --no-mcp-add)        NO_MCP_ADD=1; shift ;;
    --mcp-scope=*)       MCP_SCOPE="${1#*=}"; shift ;;
    --version=*)         VERSION="${1#*=}"; shift ;;
    -h|--help)           usage; exit 0 ;;
    *)                   err "Unknown option: $1"; usage >&2; exit 1 ;;
  esac
done

case "$MCP_SCOPE" in
  user|project|local) ;;
  *) err "Invalid --mcp-scope: $MCP_SCOPE (expected: user, project, local)"; exit 1 ;;
esac

printf '\n%s╔═══════════════════════════════════════════════════════════╗%s\n' "$CYAN" "$NC"
printf '%s║%s  %srenovate-mcp%s — Renovate config design over MCP        %s║%s\n' "$CYAN" "$NC" "$BOLD" "$NC" "$CYAN" "$NC"
printf '%s╚═══════════════════════════════════════════════════════════╝%s\n\n' "$CYAN" "$NC"

# --- OS guard ----------------------------------------------------------------
case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    warn "renovate-mcp supports Linux and macOS only (package.json declares os: [darwin, linux])."
    info "On Windows, use WSL2 or add this snippet to your client config manually:"
    cat <<'JSON'
{
  "mcpServers": {
    "renovate": {
      "command": "npx",
      "args": ["-y", "renovate-mcp"]
    }
  }
}
JSON
    exit 0
    ;;
esac

# --- Requirements ------------------------------------------------------------
step "Checking requirements..."

if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. renovate-mcp requires Node.js >= 24."
  printf '  Install with fnm: %scurl -fsSL https://fnm.vercel.app/install | bash && fnm install 24%s\n' "$BOLD" "$NC"
  exit 1
fi

NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt 24 ]; then
  err "Node.js >= 24 required (found v${NODE_VERSION})."
  printf '  Upgrade with fnm: %sfnm install 24 && fnm use 24%s\n' "$BOLD" "$NC"
  exit 1
fi
substep "Node.js ${GREEN}v${NODE_VERSION}${NC} ✓"

if ! command -v npm >/dev/null 2>&1; then
  err "npm not found (should ship with Node.js)."
  exit 1
fi
substep "npm ${GREEN}v$(npm -v)${NC} ✓"

if command -v claude >/dev/null 2>&1; then
  substep "Claude Code CLI detected ✓"
  HAS_CLAUDE=1
else
  substep "Claude Code CLI not on PATH (auto-registration will be skipped)"
  HAS_CLAUDE=0
fi
echo

# --- Mode selection ----------------------------------------------------------
if [ -z "$GLOBAL" ] && [ "$NPX_EXPLICIT" = "0" ]; then
  if [ -t 0 ]; then
    step "Install mode"
    printf '  %s1)%s npx (no global install — run on demand) %s[default]%s\n' "$BOLD" "$NC" "$DIM" "$NC"
    printf '  %s2)%s global (npm install -g renovate-mcp)\n' "$BOLD" "$NC"
    printf '  Choice [1/2]: '
    read -r MODE_CHOICE </dev/tty || MODE_CHOICE=""
    case "${MODE_CHOICE:-1}" in
      2|g|global|G) GLOBAL=1 ;;
      *)            GLOBAL=0 ;;
    esac
    echo
  else
    GLOBAL=0
  fi
fi

if [ "${GLOBAL:-0}" = "1" ]; then
  MODE="global"
else
  MODE="npx"
fi
substep "Mode: ${BOLD}${MODE}${NC}"
substep "Package: ${BOLD}renovate-mcp@${VERSION}${NC}"
echo

# --- Install -----------------------------------------------------------------
if [ "$MODE" = "global" ]; then
  step "Installing renovate-mcp@${VERSION} globally..."
  if ! npm install -g "renovate-mcp@${VERSION}"; then
    err "npm install -g failed."
    exit 1
  fi
  BIN_CMD=("renovate-mcp")
  if ! command -v renovate-mcp >/dev/null 2>&1; then
    warn "renovate-mcp installed but not on PATH yet — your shell may need to be restarted."
    BIN_CMD=("npx" "-y" "renovate-mcp@${VERSION}")
  fi
else
  step "Warming npx cache for renovate-mcp@${VERSION}..."
  # `npm exec` downloads the package without spawning the server (which blocks on stdin).
  if ! npm exec --yes --package="renovate-mcp@${VERSION}" -- node -e "process.exit(0)"; then
    err "Failed to fetch renovate-mcp@${VERSION} from npm."
    exit 1
  fi
  BIN_CMD=("npx" "-y" "renovate-mcp@${VERSION}")
fi
ok "Installed"
echo

# --- Verification (MCP initialize handshake) ---------------------------------
step "Verifying with MCP initialize handshake..."

# Spawn the resolved binary and send a JSON-RPC initialize request over stdin.
# Reuses the request shape from scripts/smoke-test-tarball.mjs.
VERIFY_OUT="$(mktemp)"
VERIFY_ERR="$(mktemp)"
trap 'rm -f "$VERIFY_OUT" "$VERIFY_ERR"' EXIT

INIT_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"renovate-mcp-installer","version":"0"}}}'

if printf '%s\n' "$INIT_REQUEST" | "${BIN_CMD[@]}" >"$VERIFY_OUT" 2>"$VERIFY_ERR" & then
  VERIFY_PID=$!
  # Poll the output for up to 15s (npx cold start can be slow on first run).
  for _ in $(seq 1 30); do
    if grep -q '"serverInfo"' "$VERIFY_OUT" 2>/dev/null; then break; fi
    sleep 0.5
  done
  kill "$VERIFY_PID" 2>/dev/null || true
  wait "$VERIFY_PID" 2>/dev/null || true
fi

if grep -q '"name":"renovate-mcp"' "$VERIFY_OUT" 2>/dev/null; then
  ok "Server responded to initialize"
else
  err "Verification failed — no initialize response from renovate-mcp."
  if [ -s "$VERIFY_ERR" ]; then
    printf '%s--- server stderr ---%s\n' "$DIM" "$NC"
    tail -n 20 "$VERIFY_ERR" >&2
  fi
  exit 1
fi
echo

# --- MCP registration --------------------------------------------------------
if [ "$MODE" = "global" ]; then
  CLIENT_CMD="renovate-mcp"
  CLIENT_ARGS_JSON='[]'
else
  CLIENT_CMD="npx"
  CLIENT_ARGS_JSON='["-y", "renovate-mcp"]'
fi

if [ "$HAS_CLAUDE" = "1" ] && [ -z "$NO_MCP_ADD" ]; then
  step "Registering with Claude Code (scope: ${MCP_SCOPE})..."
  if [ "$MODE" = "global" ]; then
    if claude mcp add renovate -s "$MCP_SCOPE" -- renovate-mcp 2>/tmp/claude-mcp-add.err; then
      ok "Registered as 'renovate' in Claude Code (${MCP_SCOPE} scope)"
    else
      warn "claude mcp add failed (entry may already exist)."
      tail -n 5 /tmp/claude-mcp-add.err >&2 || true
      info "To replace it: claude mcp remove renovate -s ${MCP_SCOPE} && re-run this installer"
    fi
  else
    if claude mcp add renovate -s "$MCP_SCOPE" -- npx -y renovate-mcp 2>/tmp/claude-mcp-add.err; then
      ok "Registered as 'renovate' in Claude Code (${MCP_SCOPE} scope)"
    else
      warn "claude mcp add failed (entry may already exist)."
      tail -n 5 /tmp/claude-mcp-add.err >&2 || true
      info "To replace it: claude mcp remove renovate -s ${MCP_SCOPE} && re-run this installer"
    fi
  fi
  rm -f /tmp/claude-mcp-add.err
  echo
else
  if [ "$HAS_CLAUDE" = "1" ]; then
    info "Skipping Claude Code registration (--no-mcp-add)."
  fi
  step "Add this block to your MCP client config:"
  printf '%s' "$DIM"
  cat <<JSON
{
  "mcpServers": {
    "renovate": {
      "command": "${CLIENT_CMD}",
      "args": ${CLIENT_ARGS_JSON}
    }
  }
}
JSON
  printf '%s\n' "$NC"
  substep "Claude Code:   ${BOLD}.mcp.json${NC} (project) or ${BOLD}~/.claude.json${NC} (user)"
  substep "Claude Desktop: ${BOLD}~/Library/Application Support/Claude/claude_desktop_config.json${NC}"
  echo
fi

# --- Quick start -------------------------------------------------------------
printf '%s╔═══════════════════════════════════════════════════════════╗%s\n' "$CYAN" "$NC"
printf '%s║%s  %sNext steps%s                                               %s║%s\n' "$CYAN" "$NC" "$BOLD" "$NC" "$CYAN" "$NC"
printf '%s╚═══════════════════════════════════════════════════════════╝%s\n\n' "$CYAN" "$NC"

cat <<EOF
  1. Restart your MCP client so it picks up the new server.
  2. Prompt it:  "List the namespaces available under renovate://presets."
  3. For platform-aware tools (dry_run, resolve_config with externalPresets),
     set RENOVATE_PLATFORM / RENOVATE_ENDPOINT / RENOVATE_TOKEN in the client's
     mcpServers.renovate.env block — see the README "Platform setup" section.
  4. Offline-only users can silence the partial-availability startup notice
     with RENOVATE_MCP_REQUIRE_CLI=false.

  Docs: https://github.com/tibuntu/renovate-mcp
EOF
echo
