#!/usr/bin/env bash
# obsidian-setup.sh
# Registers the agent-memory directory as an Obsidian vault and writes a
# minimal .obsidian/ config (graph plugin on, wikilink mode).
#
# Usage:
#   ./scripts/obsidian-setup.sh                    # uses ~/agent-memory
#   MEMORY_DIR=/path/to/mem ./scripts/obsidian-setup.sh
#
# Idempotent: safe to run multiple times.
# No GPU-sandbox flag needed on macOS/Linux.

set -euo pipefail

MEMORY_DIR="${MEMORY_DIR:-$HOME/agent-memory}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

write_bom_free() {
    # $1 = path, $2 = content
    # printf avoids locale-dependent BOM that some tools inject
    printf '%s' "$2" > "$1"
}

hex_id() {
    # 16 lowercase hex chars
    od -An -N8 -tx1 /dev/urandom | tr -d ' \n' | head -c 16
}

os_obsidian_json() {
    case "$(uname -s)" in
        Darwin) echo "$HOME/Library/Application Support/obsidian/obsidian.json" ;;
        *)      echo "$HOME/.config/obsidian/obsidian.json" ;;
    esac
}

# ---------------------------------------------------------------------------
# 1. Resolve memory directory
# ---------------------------------------------------------------------------

mkdir -p "$MEMORY_DIR"
echo "Memory dir : $MEMORY_DIR"

# ---------------------------------------------------------------------------
# 2. Write minimal .obsidian/ config
# ---------------------------------------------------------------------------

OBSIDIAN_DIR="$MEMORY_DIR/.obsidian"
mkdir -p "$OBSIDIAN_DIR"

APP_JSON="$OBSIDIAN_DIR/app.json"
if [ ! -f "$APP_JSON" ]; then
    write_bom_free "$APP_JSON" '{"useMarkdownLinks":false}'
    echo "Created  : $APP_JSON"
else
    # Merge useMarkdownLinks into existing JSON (requires python3 or node)
    if command -v python3 &>/dev/null; then
        python3 - "$APP_JSON" <<'PYEOF'
import json, sys
p = sys.argv[1]
with open(p) as f:
    d = json.load(f)
d["useMarkdownLinks"] = False
with open(p, "w", encoding="utf-8") as f:
    json.dump(d, f, separators=(",", ":"))
PYEOF
        echo "Updated  : $APP_JSON (useMarkdownLinks set)"
    elif command -v node &>/dev/null; then
        node -e "
const p=process.argv[1];
const d=JSON.parse(require('fs').readFileSync(p,'utf8'));
d.useMarkdownLinks=false;
require('fs').writeFileSync(p,JSON.stringify(d));
" "$APP_JSON"
        echo "Updated  : $APP_JSON (useMarkdownLinks set)"
    else
        echo "Warning  : python3/node not found; set useMarkdownLinks:false in $APP_JSON manually"
    fi
fi

CORE_PLUGINS="$OBSIDIAN_DIR/core-plugins.json"
if [ ! -f "$CORE_PLUGINS" ]; then
    write_bom_free "$CORE_PLUGINS" '["graph"]'
    echo "Created  : $CORE_PLUGINS"
else
    # Add graph if missing
    if ! grep -q '"graph"' "$CORE_PLUGINS"; then
        if command -v python3 &>/dev/null; then
            python3 - "$CORE_PLUGINS" <<'PYEOF'
import json, sys
p = sys.argv[1]
with open(p) as f:
    plugins = json.load(f)
if "graph" not in plugins:
    plugins.append("graph")
with open(p, "w", encoding="utf-8") as f:
    json.dump(plugins, f, separators=(",", ":"))
PYEOF
        fi
        echo "Updated  : $CORE_PLUGINS (graph added)"
    else
        echo "OK       : $CORE_PLUGINS (graph already enabled)"
    fi
fi

# ---------------------------------------------------------------------------
# 3. Register vault in Obsidian's global obsidian.json
# ---------------------------------------------------------------------------

GLOBAL_JSON="$(os_obsidian_json)"
GLOBAL_DIR="$(dirname "$GLOBAL_JSON")"
mkdir -p "$GLOBAL_DIR"

# Use python3 for JSON manipulation; fall back gracefully if absent
if ! command -v python3 &>/dev/null; then
    echo "Warning  : python3 not found; cannot auto-register vault in $GLOBAL_JSON"
    echo "           Add the vault manually in Obsidian (Open another vault -> Open folder)."
else
    python3 - "$GLOBAL_JSON" "$MEMORY_DIR" <<'PYEOF'
import json, os, sys, time, secrets

global_json = sys.argv[1]
memory_dir  = sys.argv[2]

if os.path.exists(global_json):
    with open(global_json, encoding="utf-8") as f:
        raw = f.read().strip()
    config = json.loads(raw) if raw else {}
else:
    config = {}

config.setdefault("vaults", {})

# Check if already registered
for vid, vdata in config["vaults"].items():
    if vdata.get("path") == memory_dir:
        print(f"OK       : vault already registered (id {vid})")
        sys.exit(0)

new_id = secrets.token_hex(8)   # 16 hex chars
config["vaults"][new_id] = {
    "path": memory_dir,
    "ts":   int(time.time() * 1000),
    "open": True,
}

with open(global_json, "w", encoding="utf-8") as f:
    json.dump(config, f, separators=(",", ":"))

print(f"Registered: vault id {new_id} -> {memory_dir}")
PYEOF
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo "Obsidian vault setup complete."
echo "  Vault  : $MEMORY_DIR"
echo "  Config : $OBSIDIAN_DIR"
echo ""
echo "Open Obsidian -> the vault should appear in the vault switcher."
echo "Graph view: Cmd+G (macOS) or Ctrl+G (Linux) inside the vault."
echo ""
echo "Verify: after opening the vault, check that .obsidian/workspace.json"
echo "  has been written (its mtime will be recent). If the file does not"
echo "  appear within 10 seconds of Obsidian opening, the vault did not load."
