#!/usr/bin/env bash
# Ajoute le MCP GA4 + Search Console à Claude Desktop sans écraser les autres MCPs déjà configurés.
set -euo pipefail

CONFIG_DIR="$HOME/Library/Application Support/Claude"
CONFIG_FILE="$CONFIG_DIR/claude_desktop_config.json"
WORKER_URL="https://mcp-ga4-gsc.rablab.workers.dev/sse"
KEY="ga4-gsc-rablab"

mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "{\"mcpServers\":{}}" > "$CONFIG_FILE"
fi

# Backup
cp "$CONFIG_FILE" "$CONFIG_FILE.bak.$(date +%s)"

# Merge via node, preserve existing keys
node <<NODE
const fs = require('fs');
const path = "$CONFIG_FILE";
const cfg = JSON.parse(fs.readFileSync(path, 'utf8') || '{"mcpServers":{}}');
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers["$KEY"] = {
  command: "npx",
  args: ["-y", "mcp-remote", "$WORKER_URL"]
};
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log("Updated " + path);
console.log("Existing MCPs preserved:");
Object.keys(cfg.mcpServers).forEach(k => console.log("  - " + k));
NODE

echo ""
echo "✓ MCP ga4-gsc-rablab ajouté à Claude Desktop"
echo ""
echo "Redémarre Claude Desktop (Cmd+Q puis relance) pour que le MCP soit chargé."
echo "Au premier appel, un browser s'ouvre pour le flow OAuth — connecte-toi avec ppc.rablab@gmail.com."
