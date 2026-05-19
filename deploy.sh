#!/usr/bin/env bash
# Déploiement automatique du worker mcp-ga4-gsc.rablab.workers.dev
# Tout est prerempli sauf le Client Secret Google qui doit être copié depuis :
# https://console.cloud.google.com/auth/clients/542032490673-tc2s4rd1jjjlqk1hcis0dgoljssk8eun.apps.googleusercontent.com?authuser=1&project=rablab-mcp
# (clique sur Add secret si le secret n'est plus visible, puis copie le code)

set -euo pipefail

cd "$(dirname "$0")"

GOOGLE_CLIENT_ID="542032490673-tc2s4rd1jjjlqk1hcis0dgoljssk8eun.apps.googleusercontent.com"
COOKIE_ENCRYPTION_KEY="$(openssl rand -hex 32)"

echo ""
echo "=== Worker mcp-ga4-gsc, déploiement Cloudflare ==="
echo ""
echo "Client ID Google : $GOOGLE_CLIENT_ID"
echo "Cookie Encryption Key : générée automatiquement (32 bytes hex)"
echo ""

# Etape 1, wrangler login (ouvre Chrome, accepter)
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "→ Connexion Cloudflare requise. Une page va s'ouvrir dans le browser."
  npx wrangler login
fi
echo "✓ Cloudflare auth OK"
echo ""

# Etape 2, secrets non sensibles
echo "→ Set GOOGLE_CLIENT_ID..."
echo "$GOOGLE_CLIENT_ID" | npx wrangler secret put GOOGLE_CLIENT_ID
echo ""

echo "→ Set COOKIE_ENCRYPTION_KEY..."
echo "$COOKIE_ENCRYPTION_KEY" | npx wrangler secret put COOKIE_ENCRYPTION_KEY
echo ""

echo "→ Set HOSTED_DOMAIN (vide, on accepte tous les comptes Google) ..."
echo "" | npx wrangler secret put HOSTED_DOMAIN
echo ""

# Etape 3, secret sensible, prompt
echo "──────────────────────────────────────────────────────────────"
echo " Étape manuelle : copier le Client Secret Google"
echo "──────────────────────────────────────────────────────────────"
echo " 1. Ouvre :"
echo "    https://console.cloud.google.com/auth/clients/542032490673-tc2s4rd1jjjlqk1hcis0dgoljssk8eun.apps.googleusercontent.com?authuser=1&project=rablab-mcp"
echo " 2. Si tu vois encore le code secret affiché : copie-le."
echo " 3. Sinon clique 'Add secret', le nouveau code apparait, copie-le."
echo " 4. Colle le code ci-dessous au prompt wrangler."
echo "──────────────────────────────────────────────────────────────"
echo ""
npx wrangler secret put GOOGLE_CLIENT_SECRET

echo ""
echo "✓ Tous les secrets sont en place"
echo ""

# Etape 4, deploy
echo "→ Déploiement..."
npx wrangler deploy

echo ""
echo "══════════════════════════════════════════════════════════════"
echo " Worker déployé : https://mcp-ga4-gsc.rablab.workers.dev"
echo " Endpoint MCP SSE : https://mcp-ga4-gsc.rablab.workers.dev/sse"
echo "══════════════════════════════════════════════════════════════"
echo ""
echo "Pour tester avec MCP Inspector :"
echo "  npx @modelcontextprotocol/inspector"
echo "Puis colle https://mcp-ga4-gsc.rablab.workers.dev/sse dans Inspector"
echo "et lance ga4_list_account_summaries ou gsc_list_sites."
echo ""
echo "Pour ajouter dans Claude Desktop, édite claude_desktop_config.json :"
cat <<'JSON'
{
  "mcpServers": {
    "ga4-gsc-rablab": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp-ga4-gsc.rablab.workers.dev/sse"]
    }
  }
}
JSON
