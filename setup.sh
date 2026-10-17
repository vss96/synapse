#!/usr/bin/env bash
# ── Synapse setup ──────────────────────────────────────────────────
# Run this once after cloning / downloading.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "▸ Installing dependencies..."
cd "$ROOT"
npm install

echo "▸ Building TypeScript..."
npx tsc

echo "▸ Creating data directory..."
mkdir -p "$ROOT/data"

# Write claude.json with absolute paths
cat > "$ROOT/claude.json" <<CONF
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["${ROOT}/dist/index.js"],
      "env": {
        "SYNAPSE_DATA_DIR": "${ROOT}/data"
      }
    }
  }
}
CONF

echo ""
echo "✔ Synapse ready."
echo ""
echo "  MCP server   →  npx tsx src/index.ts        (dev)"
echo "  MCP server   →  node dist/index.js           (prod)"
echo "  Viewer       →  npm run viewer   (http://localhost:4040)"
echo "  Claude Code  →  use claude.json as an MCP config"
echo ""
echo "  Claude Desktop config:"
echo '    ~/Library/Application Support/Claude/claude_desktop_config.json'
echo ""
echo "  Add to your editor's MCP config pointing at:"
echo "    ${ROOT}/claude.json"
echo ""