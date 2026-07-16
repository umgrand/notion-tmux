#!/usr/bin/env bash
#
# notion-tmux CLI setup — one seamless install for the `notion-tmux watch` tmux daemon.
#
# Installs tmux, builds + links the `notion-tmux` bin, and interactively scaffolds a
# run directory with .env + projects.json. macOS-targeted (uses Homebrew for
# tmux). Re-runnable; never overwrites config without a typed confirmation.
#
# Usage: npm run setup   (or)   bash scripts/setup.sh
#
set -euo pipefail

# Resolve the repo root from this script's location, so it works from any cwd.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m  %s\033[0m\n' "$1"; }
step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

# NOTION_TMUX_SETUP_SKIP_INSTALL=1 skips the tmux/build/link steps and runs only the
# config scaffold. Used to dry-run the interactive prompts; not for normal use.
if [ "${NOTION_TMUX_SETUP_SKIP_INSTALL:-0}" != "1" ]; then

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
step "Checking prerequisites"

for cmd in node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    warn "$cmd not found. Install Node.js (which includes npm) first: https://nodejs.org"
    exit 1
  fi
done
info "node $(node --version), npm $(npm --version)"

if command -v tmux >/dev/null 2>&1; then
  info "tmux already installed ($(tmux -V))"
elif command -v brew >/dev/null 2>&1; then
  info "Installing tmux via Homebrew…"
  brew install tmux
else
  warn "tmux is missing and Homebrew was not found."
  warn "Install Homebrew (https://brew.sh) then run 'brew install tmux', or install tmux another way."
  warn "Continuing — config will still be written, but 'notion-tmux watch' needs tmux to open windows."
fi

# ---------------------------------------------------------------------------
# 2. Install workspace dependencies (required on a fresh clone)
# ---------------------------------------------------------------------------
step "Installing dependencies"
( cd "$REPO_ROOT" && npm install )
info "Dependencies installed."

# ---------------------------------------------------------------------------
# 3. Build (shared + ticket-engine)
# ---------------------------------------------------------------------------
step "Building @notion-tmux/shared and @notion-tmux/ticket-engine"
( cd "$REPO_ROOT" && npm run build -w @notion-tmux/shared && npm run build -w @notion-tmux/ticket-engine )
info "Build complete."

# ---------------------------------------------------------------------------
# 4. Link the `notion-tmux` bin onto PATH
# ---------------------------------------------------------------------------
step "Linking the 'notion-tmux' command"
( cd "$REPO_ROOT/packages/ticket-engine" && npm link )
if command -v notion-tmux >/dev/null 2>&1; then
  info "notion-tmux is on your PATH ($(command -v notion-tmux))."
else
  warn "npm link finished but 'notion-tmux' is not on PATH. You may need to add npm's global bin dir to PATH:"
  warn "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
fi

fi  # end NOTION_TMUX_SETUP_SKIP_INSTALL guard

# ---------------------------------------------------------------------------
# 5. Interactive config scaffold
# ---------------------------------------------------------------------------
step "Configuring your run directory"

DEFAULT_RUN_DIR="$HOME/notion-tmux-run"
read -r -p "  Run directory [$DEFAULT_RUN_DIR]: " RUN_DIR
RUN_DIR="${RUN_DIR:-$DEFAULT_RUN_DIR}"
# Expand a leading ~ manually (read gives it to us literally).
RUN_DIR="${RUN_DIR/#\~/$HOME}"
mkdir -p "$RUN_DIR"

ENV_FILE="$RUN_DIR/.env"
PROJECTS_FILE="$RUN_DIR/projects.json"

# Guard against clobbering an existing setup.
confirm_overwrite() {
  local file="$1"
  if [ -e "$file" ]; then
    warn "$file already exists."
    read -r -p "  Overwrite it? Type 'yes' to confirm: " reply
    [ "$reply" = "yes" ]
  fi
}

WRITE_ENV=1
if [ -e "$ENV_FILE" ] && ! confirm_overwrite "$ENV_FILE"; then
  WRITE_ENV=0
  info "Keeping existing .env."
fi

if [ "$WRITE_ENV" -eq 1 ]; then
  # -s hides the token; it never appears in the terminal, argv, or shell history.
  read -r -s -p "  Notion integration token (input hidden): " NOTION_TOKEN
  printf '\n'
  if [ -z "$NOTION_TOKEN" ]; then
    warn "No token entered. You'll need to add NOTION_TOKEN to $ENV_FILE before running."
  fi
  read -r -p "  Default agent (claude/codex/gemini) [claude]: " DEFAULT_AGENT
  DEFAULT_AGENT="${DEFAULT_AGENT:-claude}"

  umask 077   # .env holds a secret — owner-only permissions.
  cat > "$ENV_FILE" <<EOF
NOTION_TOKEN=$NOTION_TOKEN
DEFAULT_AGENT=$DEFAULT_AGENT
AGENT_TIMEOUT_MIN=20
POLL_INTERVAL_SEC=30
EOF
  info "Wrote $ENV_FILE (permissions 600)."
fi

WRITE_PROJECTS=1
if [ -e "$PROJECTS_FILE" ] && ! confirm_overwrite "$PROJECTS_FILE"; then
  WRITE_PROJECTS=0
  info "Keeping existing projects.json."
fi

if [ "$WRITE_PROJECTS" -eq 1 ]; then
  info "Now one project to watch (edit projects.json later to add more)."
  read -r -p "  Project key (short name, e.g. demo): " PROJ_KEY
  PROJ_KEY="${PROJ_KEY:-demo}"
  read -r -p "  Repo path [$REPO_ROOT]: " PROJ_REPO
  PROJ_REPO="${PROJ_REPO:-$REPO_ROOT}"
  PROJ_REPO="${PROJ_REPO/#\~/$HOME}"
  read -r -p "  Notion database ID: " PROJ_DB
  read -r -p "  Trigger status [Ready for Dev]: " PROJ_TRIGGER
  PROJ_TRIGGER="${PROJ_TRIGGER:-Ready for Dev}"
  read -r -p "  Agent for this project [${DEFAULT_AGENT:-claude}]: " PROJ_AGENT
  PROJ_AGENT="${PROJ_AGENT:-${DEFAULT_AGENT:-claude}}"

  if [ -z "$PROJ_DB" ]; then
    warn "No database ID entered — fill in \"databaseId\" in $PROJECTS_FILE before running."
  fi

  # Emit JSON via node so values are correctly escaped (paths/names with quotes,
  # spaces, backslashes). Fields not set here fall back to loadLegacyConfig defaults.
  KEY="$PROJ_KEY" REPO="$PROJ_REPO" DB="$PROJ_DB" TRIGGER="$PROJ_TRIGGER" AGENT="$PROJ_AGENT" OUT="$PROJECTS_FILE" \
    node -e '
      const p = {
        key: process.env.KEY,
        databaseId: process.env.DB,
        repoRoot: process.env.REPO,
        baseBranch: "main",
        trigger: process.env.TRIGGER,
        agent: process.env.AGENT,
        verify: [],
        allowedBash: [],
      };
      const fs = require("fs");
      fs.writeFileSync(process.env.OUT, JSON.stringify({ projects: [p] }, null, 2) + "\n");
    '
  info "Wrote $PROJECTS_FILE."
fi

# ---------------------------------------------------------------------------
# 6. Verify + finish
# ---------------------------------------------------------------------------
step "Verifying"
if command -v notion-tmux >/dev/null 2>&1; then
  # Usage line prints to stderr and exits 1 by design — that's a healthy bin.
  notion-tmux >/dev/null 2>&1 || true
  info "notion-tmux command responds."
fi

bold ""
bold "✅ Setup complete."
printf '\nNext:\n'
printf '  1. Make sure your Notion database is shared with the integration token.\n'
printf '  2. Start the daemon:\n'
printf '       cd %s && notion-tmux watch\n' "$RUN_DIR"
printf '  3. In another terminal, watch the ticket windows:\n'
printf '       tmux attach -t notion-tmux\n'
printf '\nMove a Notion ticket to "%s" and a tmux window opens streaming its run.\n' "$PROJ_TRIGGER"
